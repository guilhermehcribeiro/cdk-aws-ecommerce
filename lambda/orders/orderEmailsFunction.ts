import { Context, SNSMessage, SQSEvent } from "aws-lambda";
import { AWSError, SES } from "aws-sdk";
import * as AWSXRay from "aws-xray-sdk";
import { Envelop, OrderEvent } from "/opt/nodejs/orderEventsLayer";
import { PromiseResult } from "aws-sdk/lib/request";

AWSXRay.captureAWS(require("aws-sdk"));
const sesClient = new SES();
export async function handler(event: SQSEvent, context: Context) {
  const emailPromises: Promise<
    PromiseResult<SES.SendEmailResponse, AWSError>
  >[] = [];
  event.Records.forEach((record) => {
    const body = JSON.parse(record.body) as SNSMessage;
    emailPromises.push(sendOrderEmail(body));
  });

  await Promise.all(emailPromises);

  return;
}

function sendOrderEmail(body: SNSMessage) {
  const envelop = JSON.parse(body.Message) as Envelop;
  const event = JSON.parse(envelop.data) as OrderEvent;

  const params: SES.SendEmailRequest = {
    Destination: {
      ToAddresses: [event.email],
    },
    Message: {
      Body: {
        Text: {
          Charset: "UTF-8",
          Data: `Recebemos o seu pedido de nº ${event.orderId}, no valor de R$ ${event.billing.totalPrice}`,
        },
      },
      Subject: {
        Charset: "UTF-8",
        Data: "Recebemos o seu pedido!",
      },
    },
    Source: "guilhermehcr97@gmail.com",
    ReplyToAddresses: ["guilhermehcr97@gmail.com"],
  };

  return sesClient.sendEmail(params).promise();
}
