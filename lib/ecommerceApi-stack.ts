import * as cdk from "aws-cdk-lib";
import * as apiGateway from "aws-cdk-lib/aws-apigateway";
import * as lambdaNodeJS from "aws-cdk-lib/aws-lambda-nodejs";
import * as cwLogs from "aws-cdk-lib/aws-logs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

interface ECommerceApiStackProps extends cdk.StackProps {
  productsFetchHandler: lambdaNodeJS.NodejsFunction;
  productsAdminHandler: lambdaNodeJS.NodejsFunction;
  ordersHandler: lambdaNodeJS.NodejsFunction;
  orderEventsFetchHandler: lambdaNodeJS.NodejsFunction;
}

export class ECommerceApiStack extends cdk.Stack {
  private productsAuthorizer: apiGateway.CognitoUserPoolsAuthorizer;
  private productsAdminAuthorizer: apiGateway.CognitoUserPoolsAuthorizer;
  private customerPool: cognito.UserPool;
  private adminPool: cognito.UserPool;

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
    this.createCognitoAuth();
    this.createProductsService(props, api);
    this.createOrderService(props, api);
  }

  private createCognitoAuth() {
    //
    const postConfirmationHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "PostConfirmationFunction",
      {
        functionName: "PostConfirmationFunction",
        entry: "lambda/auth/postConfirmationFunction.ts",
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

    const preAuthenticationHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "PreAuthenticationFunction",
      {
        functionName: "PreAuthenticationFunction",
        entry: "lambda/auth/preAuthenticationFunction.ts",
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

    // Cognito custome rUserPoll
    this.customerPool = new cognito.UserPool(this, "CustomerPool", {
      lambdaTriggers: {
        preAuthentication: preAuthenticationHandler,
        postConfirmation: postConfirmationHandler,
      },
      userPoolName: "CustomerPool",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      selfSignUpEnabled: true,
      autoVerify: {
        email: true,
        phone: false,
      },
      userVerification: {
        emailSubject: "Verify your email for the ECommerce service!",
        emailBody:
          "Thanks for signing up to ECommerce service! Your verification code is {####}",
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      signInAliases: {
        username: false,
        email: true,
      },
      standardAttributes: {
        fullname: {
          required: true,
          mutable: false,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    });

    //Cognito admin user pool

    this.adminPool = new cognito.UserPool(this, "AdminPool", {
      lambdaTriggers: {
        preAuthentication: preAuthenticationHandler,
        postConfirmation: postConfirmationHandler,
      },
      userPoolName: "AdminPool",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      selfSignUpEnabled: false,
      userInvitation: {
        emailSubject: "Welcome to ECCommerce Admin Service",
        emailBody:
          "Your username is {username} and temporary password is {####}",
      },
      signInAliases: {
        username: false,
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: false,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    });

    this.customerPool.addDomain("CustomerDomain", {
      cognitoDomain: {
        domainPrefix: "ghcr-customer-service",
      },
    });

    this.adminPool.addDomain("AdminDomain", {
      cognitoDomain: {
        domainPrefix: "ghcr-admin-service",
      },
    });

    const customerWebScope = new cognito.ResourceServerScope({
      scopeName: "web",
      scopeDescription: "Customer web operation",
    });

    const customerMobileScope = new cognito.ResourceServerScope({
      scopeName: "mobile",
      scopeDescription: "Customer mobile operation",
    });

    const adminWebScope = new cognito.ResourceServerScope({
      scopeName: "web",
      scopeDescription: "Admin web operation",
    });

    const customerResourceServer = this.customerPool.addResourceServer(
      "CustomerResourceServer",
      {
        identifier: "customer",
        userPoolResourceServerName: "CustomerResourceServer",
        scopes: [customerWebScope, customerMobileScope],
      }
    );

    const adminResourceServer = this.adminPool.addResourceServer(
      "AdminResourceServer",
      {
        identifier: "admin",
        userPoolResourceServerName: "AdminResourceServer",
        scopes: [adminWebScope],
      }
    );

    this.customerPool.addClient("customer-web-client", {
      userPoolClientName: "customerWebClient",
      authFlows: {
        userPassword: true,
      },
      accessTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.days(7),
      oAuth: {
        scopes: [
          cognito.OAuthScope.resourceServer(
            customerResourceServer,
            customerWebScope
          ),
        ],
      },
    });

    this.customerPool.addClient("customer-mobile-client", {
      userPoolClientName: "customerMobileClient",
      authFlows: {
        userPassword: true,
      },
      accessTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.days(7),
      oAuth: {
        scopes: [
          cognito.OAuthScope.resourceServer(
            customerResourceServer,
            customerMobileScope
          ),
        ],
      },
    });

    this.adminPool.addClient("admin-web-client", {
      userPoolClientName: "adminWebClient",
      authFlows: {
        userPassword: true,
      },
      accessTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.days(7),
      oAuth: {
        scopes: [
          cognito.OAuthScope.resourceServer(adminResourceServer, adminWebScope),
        ],
      },
    });

    this.productsAuthorizer = new apiGateway.CognitoUserPoolsAuthorizer(
      this,
      "ProductsAuthorizer",
      {
        authorizerName: "ProductsAuthorizer",
        cognitoUserPools: [this.customerPool, this.adminPool],
      }
    );

    this.productsAdminAuthorizer = new apiGateway.CognitoUserPoolsAuthorizer(
      this,
      "ProductsAdminAuthorizer",
      {
        authorizerName: "ProductsAdminAuthorizer",
        cognitoUserPools: [this.adminPool],
      }
    );
  }
  private createOrderService(
    props: ECommerceApiStackProps,
    api: apiGateway.RestApi
  ) {
    const ordersIntegration = new apiGateway.LambdaIntegration(
      props.ordersHandler
    );

    const ordersResource = api.root.addResource("orders");
    ordersResource.addMethod("GET", ordersIntegration);
    const orderRequestValidator = new apiGateway.RequestValidator(
      this,
      "OrderRequestValidator",
      {
        restApi: api,
        requestValidatorName: "OrderRequestValidator",
        validateRequestBody: true,
      }
    );
    const orderModel = new apiGateway.Model(this, "OrderModel", {
      modelName: "OrderModel",
      restApi: api,
      schema: {
        type: apiGateway.JsonSchemaType.OBJECT,
        properties: {
          email: {
            type: apiGateway.JsonSchemaType.STRING,
          },
          productsIds: {
            type: apiGateway.JsonSchemaType.ARRAY,
            minItems: 1,
            items: {
              type: apiGateway.JsonSchemaType.STRING,
            },
          },
          payment: {
            type: apiGateway.JsonSchemaType.STRING,
            enum: ["CASH", "DEBIT_CARD", "CREDIT_CARD"],
          },
        },
        required: ["email", "productsIds", "payment"],
      },
    });
    ordersResource.addMethod("POST", ordersIntegration, {
      requestValidator: orderRequestValidator,
      requestModels: {
        "application/json": orderModel,
      },
    });

    const orderDeleteValidation = new apiGateway.RequestValidator(
      this,
      "OrderDeleteValidation",
      {
        restApi: api,
        requestValidatorName: "OrderDeleteValidation",
        validateRequestParameters: true,
      }
    );
    ordersResource.addMethod("DELETE", ordersIntegration, {
      requestParameters: {
        "method.request.querystring.email": true,
        "method.request.querystring.orderId": true,
      },
      requestValidator: orderDeleteValidation,
    });

    const orderEventsResourse = ordersResource.addResource("events");
    const orderEventsFetchValidator = new apiGateway.RequestValidator(
      this,
      "OrderEventsFetchValidator",
      {
        restApi: api,
        requestValidatorName: "OrderEventsFetchValidator",
        validateRequestParameters: true,
      }
    );

    const orderEventsFetchIntegration = new apiGateway.LambdaIntegration(
      props.orderEventsFetchHandler
    );

    orderEventsResourse.addMethod("GET", orderEventsFetchIntegration, {
      requestParameters: {
        "method.request.querystring.email": true,
        "method.request.querystring.eventType": false,
      },
      requestValidator: orderEventsFetchValidator,
    });
  }

  private createProductsService(
    props: ECommerceApiStackProps,
    api: apiGateway.RestApi
  ) {
    const productsFetchIntegration = new apiGateway.LambdaIntegration(
      props.productsFetchHandler
    );

    const productsFetchWebMobileIntegrationOptions = {
      authorizer: this.productsAuthorizer,
      authorizationType: apiGateway.AuthorizationType.COGNITO,
      authorizationScopes: ["customer/web", "customer/mobile", "admin/web"],
    };

    const productsFetchWebIntegrationOptions = {
      authorizer: this.productsAuthorizer,
      authorizationType: apiGateway.AuthorizationType.COGNITO,
      authorizationScopes: ["customer/web", "admin/web"],
    };

    const productsResource = api.root.addResource("products");
    productsResource.addMethod(
      "GET",
      productsFetchIntegration,
      productsFetchWebMobileIntegrationOptions
    );

    const productIdResource = productsResource.addResource("{id}");
    productIdResource.addMethod(
      "GET",
      productsFetchIntegration,
      productsFetchWebIntegrationOptions
    );

    const productsAdminIntegration = new apiGateway.LambdaIntegration(
      props.productsAdminHandler
    );

    const productRequestValidator = new apiGateway.RequestValidator(
      this,
      "ProductRequestValidator",
      {
        restApi: api,
        requestValidatorName: "ProductRequestValidator",
        validateRequestBody: true,
      }
    );
    const productModel = new apiGateway.Model(this, "ProductModel", {
      modelName: "ProductModel",
      restApi: api,
      schema: {
        type: apiGateway.JsonSchemaType.OBJECT,
        properties: {
          model: {
            type: apiGateway.JsonSchemaType.STRING,
          },
          productUrl: {
            type: apiGateway.JsonSchemaType.STRING,
          },
          code: {
            type: apiGateway.JsonSchemaType.STRING,
          },
          price: {
            type: apiGateway.JsonSchemaType.NUMBER,
          },
          productName: {
            type: apiGateway.JsonSchemaType.STRING,
          },
        },
        required: ["code", "productName"],
      },
    });

    productsResource.addMethod("POST", productsAdminIntegration, {
      requestValidator: productRequestValidator,
      requestModels: {
        "application/json": productModel,
      },
      authorizer: this.productsAdminAuthorizer,
      authorizationType: apiGateway.AuthorizationType.COGNITO,
      authorizationScopes: ["admin/web"],
    });
    productIdResource.addMethod("PUT", productsAdminIntegration, {
      requestValidator: productRequestValidator,
      requestModels: {
        "application/json": productModel,
      },
      authorizer: this.productsAdminAuthorizer,
      authorizationType: apiGateway.AuthorizationType.COGNITO,
      authorizationScopes: ["admin/web"],
    });
    productIdResource.addMethod("DELETE", productsAdminIntegration, {
      authorizer: this.productsAdminAuthorizer,
      authorizationType: apiGateway.AuthorizationType.COGNITO,
      authorizationScopes: ["admin/web"],
    });
  }
}
