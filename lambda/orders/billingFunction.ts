import { SNSEvent, Context } from "aws-lambda";

export async function handler(event: SNSEvent, context: Context) {
  event.Records.forEach((record) => {
    console.log(record.Sns);
  });

  return;
}
