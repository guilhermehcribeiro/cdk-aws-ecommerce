import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodeJS from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export class AuditEventBusStack extends cdk.Stack {
  readonly bus: events.EventBus;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.bus = new events.EventBus(this, "AuditEventBus", {
      eventBusName: "AuditEventBus",
    });

    this.bus.archive("BusAchive", {
      eventPattern: {
        source: ["app.order"],
      },
      archiveName: "auditEvents",
      retention: cdk.Duration.days(10),
    });

    const nonValidOrderRule = new events.Rule(this, "NonValidOrderRule", {
      ruleName: "NonValidOrderRule",
      description: "Rule matching non-valid order",
      eventBus: this.bus,
      eventPattern: {
        source: ["app.order"],
        detailType: ["order"],
        detail: {
          reason: ["PRODUCT_NOT_FOUND"],
        },
      },
    });

    const ordersErrorsFunction = new lambdaNodeJS.NodejsFunction(
      this,
      "OrdersErrosFunction",
      {
        functionName: "OrdersErrosFunction",
        entry: "lambda/audit/ordersErrosFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        runtime: lambda.Runtime.NODEJS_20_X,
        tracing: lambda.Tracing.ACTIVE,
        insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_119_0,
      }
    );
    nonValidOrderRule.addTarget(
      new targets.LambdaFunction(ordersErrorsFunction)
    );

    const nonValidInvoiceRule = new events.Rule(this, "NonValidInvoiceRule", {
      ruleName: "NonValidInvoiceRule",
      description: "Rule matching non-valid invoice",
      eventBus: this.bus,
      eventPattern: {
        source: ["app.invoice"],
        detailType: ["invoice"],
        detail: {
          errorDetail: ["FAIL_NO_INVOICE_NUMBER"],
        },
      },
    });

    const invoicesErrorsFunction = new lambdaNodeJS.NodejsFunction(
      this,
      "InvoicesErrosFunction",
      {
        functionName: "InvoicesErrosFunction",
        entry: "lambda/audit/invoicesErrosFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        runtime: lambda.Runtime.NODEJS_20_X,
        tracing: lambda.Tracing.ACTIVE,
        insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_119_0,
      }
    );
    nonValidInvoiceRule.addTarget(
      new targets.LambdaFunction(invoicesErrorsFunction)
    );

    const timeoutImportInvoiceRule = new events.Rule(
      this,
      "TimeoutImportInvoiceRule",
      {
        ruleName: "TimeoutImportInvoiceRule",
        description: "Rule matching timeout import invoice",
        eventBus: this.bus,
        eventPattern: {
          source: ["app.invoice"],
          detailType: ["invoice"],
          detail: {
            errorDetail: ["TIMEOUT"],
          },
        },
      }
    );

    const invoiceImportTimeoutQueue = new sqs.Queue(
      this,
      "InvoiceImportTimeout",
      {
        queueName: "invoice-import-timeout",
      }
    );

    timeoutImportInvoiceRule.addTarget(
      new targets.SqsQueue(invoiceImportTimeoutQueue)
    );
  }
}
