import { DynamoDB } from "aws-sdk";
import * as AWSXray from "aws-xray-sdk";
import { OrderEventRepository } from "/opt/nodejs/orderEventsRepositoryLayer";
import { Context, SNSEvent } from "aws-lambda";

AWSXray.captureAWS(require("aws-sdk"));

const eventsDdb = process.env.EVENTS_DDB!;

const ddbClient = new DynamoDB.DocumentClient();
const orderEventsRepository = new OrderEventRepository(ddbClient, eventsDdb);

export async function handler(event: SNSEvent, context: Context) {}
