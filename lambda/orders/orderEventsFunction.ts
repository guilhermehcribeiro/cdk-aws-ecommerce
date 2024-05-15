import { AWSError, DynamoDB } from "aws-sdk";
import * as AWSXray from "aws-xray-sdk";
import {
  OrderEventDdb,
  OrderEventRepository,
} from "/opt/nodejs/orderEventsRepositoryLayer";
import { Context, SNSEvent, SNSMessage } from "aws-lambda";
import { Envelop, OrderEvent } from "/opt/nodejs/orderEventsLayer";
import { PromiseResult } from "aws-sdk/lib/request";

AWSXray.captureAWS(require("aws-sdk"));

const eventsDdb = process.env.EVENTS_DDB!;

const ddbClient = new DynamoDB.DocumentClient();
const orderEventsRepository = new OrderEventRepository(ddbClient, eventsDdb);

export async function handler(event: SNSEvent, context: Context) {
  const promises: Promise<
    PromiseResult<DynamoDB.DocumentClient.PutItemOutput, AWSError>
  >[] = [];

  event.Records.forEach((record) => {
    promises.push(createEvent(record.Sns));
  });

  await Promise.all(promises);

  return;
}

function createEvent(body: SNSMessage) {
  const envelop = JSON.parse(body.Message) as Envelop;
  const event = JSON.parse(envelop.data) as OrderEvent;

  console.log(`Order event - MessageId: ${body.MessageId}`);

  const timestamp = Date.now();
  const ttl = ~~(timestamp / 1000 + 5 * 60);

  const orderEventDdb: OrderEventDdb = {
    pk: `#order_${event.orderId}`,
    sk: `${envelop.eventType}#${timestamp}`,
    ttl: ttl,
    email: event.email,
    createdAt: timestamp,
    requestId: event.requestId,
    eventType: envelop.eventType,
    info: {
      orderId: event.orderId,
      productsCodes: event.productCodes,
      messageId: body.MessageId,
    },
  };

  return orderEventsRepository.createOrderEvent(orderEventDdb);
}
