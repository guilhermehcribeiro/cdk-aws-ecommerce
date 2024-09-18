import { DynamoDB, EventBridge, SNS } from "aws-sdk";
import { Order, OrderProduct, OrderRepository } from "/opt/nodejs/ordersLayer";
import { Product, ProductRepository } from "/opt/nodejs/productsLayer";
import {
  OrderEvent,
  OrderEventType,
  Envelop,
} from "/opt/nodejs/orderEventsLayer";

import * as AWSXRay from "aws-xray-sdk";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import {
  CarrierType,
  OrderProductResponse,
  OrderRequest,
  OrderResponse,
  PaymentType,
  ShippingType,
} from "/opt/nodejs/ordersApiLayer";
import { v4 as uuid } from "uuid";

AWSXRay.captureAWS(require("aws-sdk"));

const ordersDdb = process.env.ORDERS_DDB!;
const productsDdb = process.env.PRODUCTS_DDB!;
const orderEventsTopicArn = process.env.ORDER_EVENTS_TOPIC_ARN!;
const auditBusName = process.env.AUDIT_BUS_NAME!;

const ddbClient = new DynamoDB.DocumentClient();
const snsClient = new SNS();
const eventBridgeClient = new EventBridge();

const orderRepository = new OrderRepository(ddbClient, ordersDdb);
const productRepository = new ProductRepository(ddbClient, productsDdb);

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const apiRequestId = event.requestContext.requestId;
  const lambdaRequestId = context.awsRequestId;

  console.log(
    `API Gateway RequestId: ${apiRequestId} - Lambda RequestId: ${lambdaRequestId}`
  );

  if (method === "GET") {
    let data: Order | Order[];
    if (event.queryStringParameters) {
      const email = event.queryStringParameters.email!;
      const orderId = event.queryStringParameters.orderId!;

      if (email && orderId) {
        try {
          data = await orderRepository.getOrder(email, orderId);
        } catch (error) {
          console.error((<Error>error).message);
          return {
            statusCode: 404,
            body: JSON.stringify({
              message: (<Error>error).message,
            }),
          };
        }
      } else {
        data = await orderRepository.getOrdersByEmail(email);
      }
    } else {
      data = await orderRepository.getAllOrders();
    }

    const convertedOrder = Array.isArray(data)
      ? data.map(convertToOrderResponse)
      : convertToOrderResponse(data);

    return {
      statusCode: 200,
      body: JSON.stringify(convertedOrder),
    };
  } else if (method === "POST") {
    console.log("POST /orders");
    const orderRequest = JSON.parse(event.body!) as OrderRequest;
    const products = await productRepository.getProductsByIds(
      orderRequest.productsIds
    );
    if (products?.length !== orderRequest.productsIds.length) {
      const result = await eventBridgeClient
        .putEvents({
          Entries: [
            {
              Source: "app.order",
              EventBusName: auditBusName,
              DetailType: "order",
              Time: new Date(),
              Detail: JSON.stringify({
                reason: "PRODUCT_NOT_FOUND",
                orderRequest,
              }),
            },
          ],
        })
        .promise();

      console.log(result);
      return {
        statusCode: 404,
        body: JSON.stringify({
          message: "Some product was not found",
        }),
      };
    }

    const order = buildOrder(orderRequest, products);
    const createdOrderPromise = orderRepository.createOrder(order);
    const eventResultPromise = sendOrderEvent(
      order,
      OrderEventType.CREATED,
      lambdaRequestId
    );

    const results = await Promise.all([
      createdOrderPromise,
      eventResultPromise,
    ]);

    console.log(
      `Order created event sent - OrderId: ${order.sk} - MessageId: ${results[1].MessageId}`,
      results[1]
    );
    return {
      statusCode: 201,
      body: JSON.stringify(convertToOrderResponse(order)),
    };
  } else if (method === "DELETE") {
    console.log("DELETE /orders");
    const email = event.queryStringParameters!.email!;
    const orderId = event.queryStringParameters!.orderId!;

    try {
      const deletedOrder = await orderRepository.deleteOrder(email, orderId);
      const eventResult = await sendOrderEvent(
        deletedOrder,
        OrderEventType.DELETED,
        lambdaRequestId
      );
      console.log(
        `Order deleted event sent - OrderId: ${deletedOrder.sk} - MessageId: ${eventResult.MessageId}`,
        eventResult
      );
      return {
        statusCode: 200,
        body: JSON.stringify(convertToOrderResponse(deletedOrder)),
      };
    } catch (error) {
      console.error((<Error>error).message);
      return {
        statusCode: 404,
        body: JSON.stringify({
          message: (<Error>error).message,
        }),
      };
    }
  }

  return {
    statusCode: 400,
    body: JSON.stringify({
      message: "Bad Request",
    }),
  };
}

function sendOrderEvent(
  order: Order,
  eventType: OrderEventType,
  lambdaRequestId: string
) {
  const productCodes = order.products?.map((product) => product.code) || [];
  const orderEvent: OrderEvent = {
    email: order.pk,
    orderId: order.sk!,
    billing: {
      payment: order.billing.payment,
      totalPrice: order.billing.totalPrice,
    },
    shipping: {
      carrier: order.shipping.carrier,
      type: order.shipping.type,
    },
    requestId: lambdaRequestId,
    productCodes: productCodes,
  };
  const envelop: Envelop = {
    eventType,
    data: JSON.stringify(orderEvent),
  };
  return snsClient
    .publish({
      TopicArn: orderEventsTopicArn,
      Message: JSON.stringify(envelop),
      MessageAttributes: {
        eventType: {
          DataType: "String",
          StringValue: eventType,
        },
      },
    })
    .promise();
}

function buildOrder(orderRequest: OrderRequest, products: Product[]): Order {
  const orderProducts: OrderProduct[] = [];
  let totalPrice = 0;

  products.forEach((product) => {
    totalPrice += product.price;
    orderProducts.push({
      code: product.code,
      price: product.price,
    });
  });

  return {
    pk: orderRequest.email,
    sk: uuid(),
    createdAt: Date.now(),
    billing: {
      payment: orderRequest.payment,
      totalPrice: totalPrice,
    },
    shipping: {
      type: orderRequest.shipping.type,
      carrier: orderRequest.shipping.carrier,
    },
    products: orderProducts,
  };
}

function convertToOrderResponse(order: Order): OrderResponse {
  const orderProducts: OrderProductResponse[] = [];
  order.products?.forEach((product) => {
    orderProducts.push({
      code: product.code,
      price: product.price,
    });
  });

  return {
    email: order.pk,
    id: order.sk!,
    createdAt: order.createdAt!,
    products: orderProducts.length > 0 ? orderProducts : undefined,
    billing: {
      payment: order.billing.payment as PaymentType,
      totalPrice: order.billing.totalPrice,
    },
    shipping: {
      type: order.shipping.type as ShippingType,
      carrier: order.shipping.carrier as CarrierType,
    },
  };
}
