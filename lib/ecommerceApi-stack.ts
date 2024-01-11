import * as cdk from "aws-cdk-lib";
import * as apiGateway from "aws-cdk-lib/aws-apigateway";
import * as lambdaNodeJS from "aws-cdk-lib/aws-lambda-nodejs";
import * as cwLogs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

interface ECommerceApiStackProps extends cdk.StackProps {
  productsFetchHandler: lambdaNodeJS.NodejsFunction;
  productsAdminHandler: lambdaNodeJS.NodejsFunction;
}

export class ECommerceApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ECommerceApiStackProps) {
    super(scope, id, props);

    const logGroup = new cwLogs.LogGroup(this, "ECommerceApiLogs");

    const api = new apiGateway.RestApi(this, "ECommerceApi", {
      restApiName: "ECommerceApi",
      cloudWatchRole: true,
      deployOptions: {
        accessLogDestination: new apiGateway.LogGroupLogDestination(logGroup),
        accessLogFormat: apiGateway.AccessLogFormat.jsonWithStandardFields({
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          caller: true,
          user: true,
        }),
      },
    });

    const productsFetchIntegration = new apiGateway.LambdaIntegration(
      props.productsFetchHandler
    );

    const productsResource = api.root.addResource("products");
    productsResource.addMethod("GET", productsFetchIntegration);

    const productIdResource = productsResource.addResource("{id}");
    productIdResource.addMethod("GET", productsFetchIntegration);

    const productsAdminIntegration = new apiGateway.LambdaIntegration(
      props.productsAdminHandler
    );

    productsResource.addMethod("POST", productsAdminIntegration);
    productIdResource.addMethod("PUT", productsAdminIntegration);
    productIdResource.addMethod("DELETE", productsAdminIntegration);
  }
}
