import { Callback, Context, PreAuthenticationTriggerEvent } from "aws-lambda";

export async function handler(
  event: PreAuthenticationTriggerEvent,
  context: Context,
  callback: Callback
) {
  console.log(event);

  if (event.request.userAttributes.email === "teste@gmail.com") {
    callback("USER BLOCKED!", event);
  } else {
    callback(null, event);
  }
}
