import * as cdk from "aws-cdk-lib";
import * as apiGateway from "aws-cdk-lib/aws-apigateway";
import * as lambdaNodeJS from "aws-cdk-lib/aws-lambda-nodejs";
import * as cwLogs from "aws-cdk-lib/aws-logs";
import * as apigatewayv2 from "@aws-cdk/aws-apigatewayv2-alpha";
import * as apigatewayv2_integrations from "@aws-cdk/aws-apigatewayv2-integrations-alpha";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export class InvoiceWSApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // INVOICE TRANSACTION LAYER
    const invoiceTransactionLayerArn =
      ssm.StringParameter.valueForStringParameter(
        this,
        "InvoiceTransactionLayerVersionArn"
      );
    const invoiceTransactionLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "InvoiceTransactionLayer",
      invoiceTransactionLayerArn
    );

    // INVOICE LAYER
    const invoiceLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "InvoiceRepositoryLayerVersionArn"
    );
    const invoiceLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "InvoiceRepositoryLayer",
      invoiceLayerArn
    );

    // INVOICE WEBSOCKET API LAYER
    const invoiceWSConnectionLayerArn =
      ssm.StringParameter.valueForStringParameter(
        this,
        "InvoiceWSConnectionLayerVersionArn"
      );
    const invoiceWSConnectionLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "InvoiceWSConnectionLayer",
      invoiceWSConnectionLayerArn
    );

    // INVOICE AMD INVOICE TRANSACTION DDB
    const invoicesDdb = new dynamodb.Table(this, "InvoicesDdb", {
      tableName: "invoices",
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      partitionKey: {
        name: "pk",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "sk",
        type: dynamodb.AttributeType.STRING,
      },
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // INVOICE BUCKET
    const bucket = new s3.Bucket(this, "InvoiceBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          enabled: true,
          expiration: cdk.Duration.days(1),
        },
      ],
    });

    // WEBSOCKET CONNECTION HANDLER
    const connectionHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "InvoiceConnectionFunction",
      {
        functionName: "InvoiceConnectionFunction",
        entry: "lambda/invoices/invoiceConnectionFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    // WEBSOCKET DISCONNECTION HANDLER
    const disconnectionHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "InvoiceDisconnectionFunction",
      {
        functionName: "InvoiceDisconnectionFunction",
        entry: "lambda/invoices/invoiceDisconnectionFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        tracing: lambda.Tracing.ACTIVE,
      }
    );

    // WEBSOCKET API
    const webSocketApi = new apigatewayv2.WebSocketApi(this, "InvoiceWSApi", {
      apiName: "InvoiceWSApi",
      connectRouteOptions: {
        integration: new apigatewayv2_integrations.WebSocketLambdaIntegration(
          "ConnectionHandler",
          connectionHandler
        ),
      },
      disconnectRouteOptions: {
        integration: new apigatewayv2_integrations.WebSocketLambdaIntegration(
          "DisconnectionHandler",
          disconnectionHandler
        ),
      },
    });

    const stage = "prod";
    const wsApiEndpoint = `${webSocketApi.apiEndpoint}/${stage}`;
    new apigatewayv2.WebSocketStage(this, "InvoiceWSApiStage", {
      webSocketApi,
      stageName: stage,
      autoDeploy: true,
    });

    // INVOICE URL HANDLER
    const getUrlHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "InvoiceGetUrlFunction",
      {
        functionName: "InvoiceGetUrlFunction",
        entry: "lambda/invoices/invoiceGetUrlFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        layers: [invoiceTransactionLayer, invoiceWSConnectionLayer],
        tracing: lambda.Tracing.ACTIVE,
        environment: {
          INVOICES_DDB: invoicesDdb.tableName,
          BUCKET_NAME: bucket.bucketName,
          INVOICE_WSAPI_ENDPOINT: wsApiEndpoint,
        },
      }
    );

    const invoicesDdbWriteTransactionPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["dynamodb:PutItem"],
      resources: [invoicesDdb.tableArn],
      conditions: {
        ["ForAllValues:StringLike"]: {
          "dynamodb:LeadingKeys": ["#transaction_*"],
        },
      },
    });
    const invoicesBucketPutObjectPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["s3:PutObject"],
      resources: [`${bucket.bucketArn}/*`],
    });

    getUrlHandler.addToRolePolicy(invoicesDdbWriteTransactionPolicy);
    getUrlHandler.addToRolePolicy(invoicesBucketPutObjectPolicy);
    webSocketApi.grantManageConnections(getUrlHandler);

    // INVOICE IMPORT HANDLER
    const invoiceImportlHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "InvoiceImportFunction",
      {
        functionName: "InvoiceImportFunction",
        entry: "lambda/invoices/invoiceImportFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        layers: [
          invoiceLayer,
          invoiceTransactionLayer,
          invoiceWSConnectionLayer,
        ],
        tracing: lambda.Tracing.ACTIVE,
        environment: {
          INVOICES_DDB: invoicesDdb.tableName,
          INVOICE_WSAPI_ENDPOINT: wsApiEndpoint,
        },
      }
    );
    invoicesDdb.grantReadWriteData(invoiceImportlHandler);
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(invoiceImportlHandler)
    );

    const invoicesBucketGetDeleteObjectPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["s3:GetObject", "s3:DeleteObject"],
      resources: [`${bucket.bucketArn}/*`],
    });
    invoiceImportlHandler.addToRolePolicy(invoicesBucketGetDeleteObjectPolicy);
    webSocketApi.grantManageConnections(invoiceImportlHandler);

    // CANCEL IMPORT HANDLER
    const cancelImportlHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "CancelImportFunction",
      {
        functionName: "CancelImportFunction",
        entry: "lambda/invoices/cancelImportFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        layers: [invoiceTransactionLayer, invoiceWSConnectionLayer],
        tracing: lambda.Tracing.ACTIVE,
        environment: {
          INVOICES_DDB: invoicesDdb.tableName,
          INVOICE_WSAPI_ENDPOINT: wsApiEndpoint,
        },
      }
    );

    const invoicesDdbReadWriteTransactionPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["dynamodb:UpdateItem", "dynamodb:GetItem"],
      resources: [invoicesDdb.tableArn],
      conditions: {
        ["ForAllValues:StringLike"]: {
          "dynamodb:LeadingKeys": ["#transaction_*"],
        },
      },
    });
    cancelImportlHandler.addToRolePolicy(invoicesDdbReadWriteTransactionPolicy);
    webSocketApi.grantManageConnections(cancelImportlHandler);

    // WEBSOCKET API ROUTES
    webSocketApi.addRoute("getImportUrl", {
      integration: new apigatewayv2_integrations.WebSocketLambdaIntegration(
        "GetUrlHandler",
        getUrlHandler
      ),
    });

    webSocketApi.addRoute("cancelImport", {
      integration: new apigatewayv2_integrations.WebSocketLambdaIntegration(
        "CancelImportHandler",
        cancelImportlHandler
      ),
    });
  }
}
