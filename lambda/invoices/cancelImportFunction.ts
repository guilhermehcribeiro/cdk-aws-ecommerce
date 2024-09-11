import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import * as AWSXRay from "aws-xray-sdk";
import { ApiGatewayManagementApi, DynamoDB } from "aws-sdk";
import {
  InvoiceTransactionRepository,
  InvoiceTransactionStatus,
} from "/opt/nodejs/invoiceTransaction";
import { InvoiceWSService } from "/opt/nodejs/invoiceWSConnection";

AWSXRay.captureAWS(require("aws-sdk"));

const invoiceDdb = process.env.INVOICES_DDB!;
const invoicesWsApiEndpoint = process.env.INVOICE_WSAPI_ENDPOINT!.substring(6);

const ddbClient = new DynamoDB.DocumentClient();
const apigwManagementApi = new ApiGatewayManagementApi({
  endpoint: invoicesWsApiEndpoint,
});

const invoiceTransactionRepository = new InvoiceTransactionRepository(
  ddbClient,
  invoiceDdb
);
const invoiceWSService = new InvoiceWSService(apigwManagementApi);

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  const transactionId = JSON.parse(event.body!).transactionId as string;
  const lambdaRequestId = context.awsRequestId;
  const connectionId = event.requestContext.connectionId!;

  console.log(
    `ConnectionId: ${connectionId} - Lambda RequestId: ${lambdaRequestId}`
  );

  try {
    const invoice = await invoiceTransactionRepository.getInvoiceTransaction(
      transactionId
    );

    if (invoice.transactionStatus !== InvoiceTransactionStatus.GENERATED) {
      await invoiceWSService.sendInvoiceStatus(
        transactionId,
        connectionId,
        invoice.transactionStatus
      );
      console.error("Can't cancel an ongoing process");
    }

    const sendInvoiceStatusPromise = invoiceWSService.sendInvoiceStatus(
      transactionId,
      connectionId,
      InvoiceTransactionStatus.CANCELLED
    );

    const updateInvoiceStatusPromise =
      invoiceTransactionRepository.updateInvoiceTransaction(
        transactionId,
        InvoiceTransactionStatus.CANCELLED
      );

    await Promise.all([sendInvoiceStatusPromise, updateInvoiceStatusPromise]);
  } catch (error) {
    console.error((<Error>error).message);
    console.error(
      `Invoice transaction not found - TransactionId: ${transactionId}`
    );

    await invoiceWSService.sendInvoiceStatus(
      transactionId,
      connectionId,
      InvoiceTransactionStatus.NOT_FOUND
    );
  }

  await invoiceWSService.disconnectionClient(connectionId);

  return {
    statusCode: 200,
    body: "OK",
  };
}
