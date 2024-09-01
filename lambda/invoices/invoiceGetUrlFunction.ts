import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { ApiGatewayManagementApi, DynamoDB, S3 } from "aws-sdk";
import * as AWSXRay from "aws-xray-sdk";
import { v4 as uuid } from "uuid";
import {
  InvoiceTransactionStatus,
  InvoiceTransactionRepository,
} from "/opt/nodejs/invoiceTransaction";
import { InvoiceWSService } from "/opt/nodejs/invoiceWSConnection";
AWSXRay.captureAWS(require("aws-sdk"));

const invoiceDdb = process.env.INVOICES_DDB!;
const bucketName = process.env.BUCKET_NAME!;
const invoicesWsApiEndpoint = process.env.INVOICE_WSAPI_ENDPOINT!.substring(6);

const s3Client = new S3();
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
  console.log(event);

  const lambdaRequestId = context.awsRequestId;
  const connectionId = event.requestContext.connectionId!;

  console.log(
    `ConnectionId: ${connectionId} - Lambda RequestId: ${lambdaRequestId}`
  );

  const key = uuid();
  const expires = 300; // 5 minutes

  const signedUrlPut = await s3Client.getSignedUrlPromise("putObject", {
    Bucket: bucketName,
    Key: key,
    Expires: expires,
  });

  // CREATE INVOICE TRANSACTION
  const timestamp = Date.now();
  const ttl = ~~(timestamp / 1000 + 60 * 2);

  await invoiceTransactionRepository.createInvoiceTransaction({
    pk: `#transaction`,
    sk: `${key}`,
    ttl: ttl,
    requestId: lambdaRequestId,
    transactionStatus: InvoiceTransactionStatus.GENERATED,
    timestamp,
    expiresIn: expires,
    connectionId,
    endpoint: invoicesWsApiEndpoint,
  });

  // SEND URL BACK TO WS CONNECTED CLIENT
  const postData = JSON.stringify({
    url: signedUrlPut,
    expires,
    transactionId: key,
  });

  await invoiceWSService.sendData(connectionId, postData);

  return {
    statusCode: 200,
    body: "OK",
  };
}
