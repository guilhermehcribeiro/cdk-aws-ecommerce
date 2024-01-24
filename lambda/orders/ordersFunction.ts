import { DynamoDB } from "aws-sdk";
import { Order, OrderProduct, OrderRepository } from "/opt/nodejs/ordersLayer";
import { Product, ProductRepository } from "/opt/nodejs/productsLayer";

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

AWSXRay.captureAWS(require("aws-sdk"));

const ordersDdb = process.env.ORDERS_DDB!;
const productsDdb = process.env.PRODUCTS_DDB!;

const ddbClient = new DynamoDB.DocumentClient();

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
      return {
        statusCode: 404,
        body: JSON.stringify({
          message: "Some product was not found",
        }),
      };
    }

    const order = buildOrder(orderRequest, products);
    const createdOrder = await orderRepository.createOrder(order);

    return {
      statusCode: 201,
      body: JSON.stringify(convertToOrderResponse(createdOrder)),
    };
  } else if (method === "DELETE") {
    console.log("DELETE /orders");
    const email = event.queryStringParameters!.email!;
    const orderId = event.queryStringParameters!.orderId!;

    try {
      const deletedOrder = await orderRepository.deleteOrder(email, orderId);

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
  order.products.forEach((product) => {
    orderProducts.push({
      code: product.code,
      price: product.price,
    });
  });

  return {
    email: order.pk,
    id: order.sk!,
    createdAt: order.createdAt!,
    products: orderProducts,
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
