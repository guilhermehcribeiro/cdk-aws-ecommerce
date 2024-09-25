import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodeJS from "aws-cdk-lib/aws-lambda-nodejs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambdaEventSource from "aws-cdk-lib/aws-lambda-event-sources";
import * as events from "aws-cdk-lib/aws-events";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import { Construct } from "constructs";

interface OrdersAppStackProps extends cdk.StackProps {
  productsDdb: dynamodb.Table;
  eventsDdb: dynamodb.Table;
  auditBus: events.EventBus;
}

export class OrdersAppStack extends cdk.Stack {
  readonly ordersHandler: lambdaNodeJS.NodejsFunction;
  readonly orderEventsFetchHandler: lambdaNodeJS.NodejsFunction;

  constructor(scope: Construct, id: string, props: OrdersAppStackProps) {
    super(scope, id, props);

    const ordersDdb = new dynamodb.Table(this, "OrdersDdb", {
      tableName: "orders",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      partitionKey: {
        name: "pk",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "sk",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
    });

    const writeThrottleEventsMetric = ordersDdb.metric("WriteThrottleEvents", {
      period: cdk.Duration.minutes(2),
      statistic: "SampleCount",
      unit: cw.Unit.COUNT,
    });

    writeThrottleEventsMetric.createAlarm(this, "WriteThrottleEventsAlarm", {
      alarmName: "WriteThrottleEvents",
      actionsEnabled: false,
      evaluationPeriods: 1,
      threshold: 10,
      comparisonOperator:
        cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    const ordersLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "OrdersLayerVersionArn"
    );

    const ordersLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "OrdersLayerVersionArn",
      ordersLayerArn
    );

    const ordersApiLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "OrdersApiLayerVersionArn"
    );

    const ordersApiLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "OrdersApiLayerVersionArn",
      ordersApiLayerArn
    );

    const orderEventsLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "OrderEventsLayerArn"
    );

    const orderEventsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "OrderEventsLayerArn",
      orderEventsLayerArn
    );

    const orderEventsRepositoryLayerArn =
      ssm.StringParameter.valueForStringParameter(
        this,
        "OrderEventsRepositoryLayerArn"
      );

    const orderEventsRepositoryLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "OrderEventsRepositoryLayerArn",
      orderEventsRepositoryLayerArn
    );

    const productsLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "ProductsLayerVersionArn"
    );

    const productsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "ProductsLayerVersionArn",
      productsLayerArn
    );

    const ordersTopic = new sns.Topic(this, "OrderEventsTopic", {
      displayName: "Order events topic",
      topicName: "order-events",
    });

    this.ordersHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "OrdersFunction",
      {
        functionName: "OrdersFunction",
        entry: "lambda/orders/ordersFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        environment: {
          PRODUCTS_DDB: props.productsDdb.tableName,
          ORDERS_DDB: ordersDdb.tableName,
          ORDER_EVENTS_TOPIC_ARN: ordersTopic.topicArn,
          AUDIT_BUS_NAME: props.auditBus.eventBusName,
        },
        layers: [ordersLayer, productsLayer, ordersApiLayer, orderEventsLayer],
        runtime: lambda.Runtime.NODEJS_20_X,
        tracing: lambda.Tracing.ACTIVE,
        insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_119_0,
      }
    );

    ordersDdb.grantReadWriteData(this.ordersHandler);
    props.productsDdb.grantReadData(this.ordersHandler);
    ordersTopic.grantPublish(this.ordersHandler);
    props.auditBus.grantPutEventsTo(this.ordersHandler);

    //metric
    const prodcutNotFoundMetricFilter =
      this.ordersHandler.logGroup.addMetricFilter("ProductNotFoundMetric", {
        metricName: "OrderWithNonValidProduct",
        metricNamespace: "ProductNotFound",
        filterPattern: logs.FilterPattern.literal("Some product was not found"),
      });

    //alarm
    const productNotFoundAlarm = prodcutNotFoundMetricFilter
      .metric()
      .with({
        statistic: "Sum",
        period: cdk.Duration.minutes(2),
      })
      .createAlarm(this, "ProductNotFoundAlarm", {
        alarmName: "OrderWithNonValidProduct",
        alarmDescription:
          "Some product was not found while creating a new order ",
        evaluationPeriods: 1,
        threshold: 2,
        actionsEnabled: true,
        comparisonOperator:
          cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      });

    //action
    const orderAlarmsTopic = new sns.Topic(this, "OrderAlarmsTopic", {
      displayName: "Order alarms topic",
      topicName: "order-alarms",
    });
    orderAlarmsTopic.addSubscription(
      new subs.EmailSubscription("guilhermehcr97@gmail.com")
    );
    productNotFoundAlarm.addAlarmAction(
      new cw_actions.SnsAction(orderAlarmsTopic)
    );

    const orderEventsHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "OrderEventsFunction",
      {
        functionName: "OrderEventsFunction",
        entry: "lambda/orders/orderEventsFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        environment: {
          EVENTS_DDB: props.eventsDdb.tableName,
        },
        layers: [orderEventsLayer, orderEventsRepositoryLayer],
        runtime: lambda.Runtime.NODEJS_20_X,
        tracing: lambda.Tracing.ACTIVE,
        insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_119_0,
      }
    );

    ordersTopic.addSubscription(
      new subs.LambdaSubscription(orderEventsHandler)
    );

    const eventsDdbPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["dynamodb:PutItem"],
      resources: [props.eventsDdb.tableArn],
      conditions: {
        ["ForAllValues:StringLike"]: {
          "dynamodb:LeadingKeys": ["#order_*"],
        },
      },
    });

    orderEventsHandler.addToRolePolicy(eventsDdbPolicy);

    const billingHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "BillingFunction",
      {
        functionName: "BillingFunction",
        entry: "lambda/orders/billingFunction.ts",
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

    ordersTopic.addSubscription(
      new subs.LambdaSubscription(billingHandler, {
        filterPolicy: {
          eventType: sns.SubscriptionFilter.stringFilter({
            allowlist: ["ORDER_CREATED"],
          }),
        },
      })
    );

    const orderEventsDlq = new sqs.Queue(this, "OrderEventsDlq", {
      queueName: "order-events-dql",
      enforceSSL: false,
      encryption: sqs.QueueEncryption.UNENCRYPTED,
      retentionPeriod: cdk.Duration.days(10),
    });

    const orderEventsQueue = new sqs.Queue(this, "OrderEventsQueue", {
      queueName: "order-events",
      enforceSSL: false,
      encryption: sqs.QueueEncryption.UNENCRYPTED,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: orderEventsDlq,
      },
    });

    ordersTopic.addSubscription(
      new subs.SqsSubscription(orderEventsQueue, {
        filterPolicy: {
          eventType: sns.SubscriptionFilter.stringFilter({
            allowlist: ["ORDER_CREATED"],
          }),
        },
      })
    );

    const orderEmailsHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "OrderEmailsFunction",
      {
        functionName: "OrderEmailsFunction",
        entry: "lambda/orders/orderEmailsFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        layers: [orderEventsLayer],
        runtime: lambda.Runtime.NODEJS_20_X,
        tracing: lambda.Tracing.ACTIVE,
        insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_119_0,
      }
    );

    orderEmailsHandler.addEventSource(
      new lambdaEventSource.SqsEventSource(
        orderEventsQueue /* {
        batchSize: 5,
        enabled: true,
        maxBatchingWindow: cdk.Duration.minutes(1),
      }*/
      )
    );
    orderEventsQueue.grantConsumeMessages(orderEmailsHandler);

    const orderEmailSesPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ses:SendEmail", "ses:SendRawEmail"],
      resources: ["*"],
    });

    orderEmailsHandler.addToRolePolicy(orderEmailSesPolicy);

    this.orderEventsFetchHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "OrderEventsFetchFunction",
      {
        functionName: "OrderEventsFetchFunction",
        entry: "lambda/orders/orderEventsFetchFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        environment: {
          EVENTS_DDB: props.eventsDdb.tableName,
        },
        layers: [orderEventsRepositoryLayer],
        runtime: lambda.Runtime.NODEJS_20_X,
        tracing: lambda.Tracing.ACTIVE,
        insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_119_0,
      }
    );

    const eventsFetchDdbPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["dynamodb:Query"],
      resources: [`${props.eventsDdb.tableArn}/index/emailIndex`],
    });
    this.orderEventsFetchHandler.addToRolePolicy(eventsFetchDdbPolicy);
  }
}
