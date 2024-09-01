import { Context, S3Event, S3EventRecord } from "aws-lambda";
import { ApiGatewayManagementApi, DynamoDB, S3 } from "aws-sdk";
import * as AWSXRay from "aws-xray-sdk";
import {
  InvoiceTransactionRepository,
  InvoiceTransactionStatus,
} from "/opt/nodejs/invoiceTransaction";
import { InvoiceWSService } from "/opt/nodejs/invoiceWSConnection";
import { InvoiceFile, InvoiceRepository } from "/opt/nodejs/invoiceRepository";

AWSXRay.captureAWS(require("aws-sdk"));

const invoiceDdb = process.env.INVOICES_DDB!;
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
const invoiceRepository = new InvoiceRepository(ddbClient, invoiceDdb);

export async function handler(event: S3Event, context: Context): Promise<void> {
  console.log(event);
  const promises: Promise<void>[] = [];
  event.Records.forEach((record) => {
    promises.push(processRecord(record));
  });

  await Promise.all(promises);
}

async function processRecord(record: S3EventRecord) {
  const key = record.s3.object.key;
  const bucketName = record.s3.bucket.name;

  try {
    const invoiceTransaction =
      await invoiceTransactionRepository.getInvoiceTransaction(key);
    if (
      invoiceTransaction.transactionStatus !==
      InvoiceTransactionStatus.GENERATED
    ) {
      await invoiceWSService.sendInvoiceStatus(
        key,
        invoiceTransaction.connectionId,
        invoiceTransaction.transactionStatus
      );
      console.error("Non valid transaction status");
      return;
    }

    await Promise.all([
      invoiceWSService.sendInvoiceStatus(
        key,
        invoiceTransaction.connectionId,
        InvoiceTransactionStatus.RECEIVED
      ),
      invoiceTransactionRepository.updateInvoiceTransaction(
        key,
        InvoiceTransactionStatus.RECEIVED
      ),
    ]);

    const object = await s3Client
      .getObject({
        Key: key,
        Bucket: bucketName,
      })
      .promise();

    const invoice = JSON.parse(object.Body!.toString("utf-8")) as InvoiceFile;
    console.log(invoice);

    const createInvoicePromise = invoiceRepository.create({
      pk: `#invoice_${invoice.customerName}`,
      sk: invoice.invoiceNumber,
      ttl: 0,
      totalValue: invoice.totalValue,
      productId: invoice.productId,
      quantity: invoice.quantity,
      transactionId: key,
      createdAt: Date.now(),
    });

    const deleteObjetPromise = s3Client
      .deleteObject({
        Key: key,
        Bucket: bucketName,
      })
      .promise();

    const updateInvoicePromise =
      invoiceTransactionRepository.updateInvoiceTransaction(
        key,
        InvoiceTransactionStatus.PROCESSED
      );

    const sendStatusPromise = invoiceWSService.sendInvoiceStatus(
      key,
      invoiceTransaction.connectionId,
      InvoiceTransactionStatus.PROCESSED
    );

    await Promise.all([
      createInvoicePromise,
      deleteObjetPromise,
      updateInvoicePromise,
      sendStatusPromise,
    ]);
  } catch (error) {
    console.error((<Error>error).message);
  }
}
