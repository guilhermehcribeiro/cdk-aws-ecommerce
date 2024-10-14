import { Callback, Context, PreAuthenticationTriggerEvent } from "aws-lambda";

export async function handler(
  event: PreAuthenticationTriggerEvent,
  context: Context,
  callback: Callback
) {
  console.log(event);

  callback(null, event);
}
