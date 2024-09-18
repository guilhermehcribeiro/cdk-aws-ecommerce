import { Context, S3Event, S3EventRecord } from "aws-lambda";
import { ApiGatewayManagementApi, DynamoDB, EventBridge, S3 } from "aws-sdk";
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
const auditBusName = process.env.AUDIT_BUS_NAME!;

const s3Client = new S3();
const ddbClient = new DynamoDB.DocumentClient();
const eventBridgeClient = new EventBridge();
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
      await invoiceWSService.disconnectionClient(
        invoiceTransaction.connectionId
      );
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

    if (invoice.invoiceNumber.toString().length < 5) {
      const putEventPromise = eventBridgeClient
        .putEvents({
          Entries: [
            {
              Source: "app.invoice",
              EventBusName: auditBusName,
              DetailType: "invoice",
              Time: new Date(),
              Detail: JSON.stringify({
                errorDetail: "FAIL_NO_INVOICE_NUMBER",
                info: {
                  invoiceKey: key,
                  customerName: invoice.customerName,
                },
              }),
            },
          ],
        })
        .promise();

      const sendInvoiceStatusPromise = invoiceWSService.sendInvoiceStatus(
        key,
        invoiceTransaction.connectionId,
        InvoiceTransactionStatus.NON_VALID_INVOICE_NUMBER
      );

      const updateInvoiceStatusPromise =
        invoiceTransactionRepository.updateInvoiceTransaction(
          key,
          InvoiceTransactionStatus.NON_VALID_INVOICE_NUMBER
        );

      await Promise.all([
        sendInvoiceStatusPromise,
        updateInvoiceStatusPromise,
        putEventPromise,
      ]);

      await invoiceWSService.disconnectionClient(
        invoiceTransaction.connectionId
      );

      console.error("Non valid invoice number");

      await invoiceWSService.disconnectionClient(
        invoiceTransaction.connectionId
      );
      return;
    }

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

    await invoiceWSService.disconnectionClient(invoiceTransaction.connectionId);
  } catch (error) {
    console.error((<Error>error).message);
  }
}
