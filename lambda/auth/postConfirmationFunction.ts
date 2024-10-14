import { Callback, Context, PostConfirmationTriggerEvent } from "aws-lambda";

export async function handler(
  event: PostConfirmationTriggerEvent,
  context: Context,
  callback: Callback
) {
  console.log(event);

  callback(null, event);
}
