import { APIGatewayEventDefaultAuthorizerContext } from "aws-lambda";
import { CognitoIdentityServiceProvider } from "aws-sdk";

export class AuthInfoService {
  private cognitoIdentityServiceProvider: CognitoIdentityServiceProvider;

  constructor(cognitoIdentityServiceProvider: CognitoIdentityServiceProvider) {
    this.cognitoIdentityServiceProvider = cognitoIdentityServiceProvider;
  }

  async getUserInfo(
    authorizer: APIGatewayEventDefaultAuthorizerContext
  ): Promise<string> {
    const userPoolId = authorizer?.claims?.iss.split("amazonaws.com/")[1];
    const username = authorizer?.claims?.username;

    const userInfo = await this.cognitoIdentityServiceProvider
      .adminGetUser({
        Username: username,
        UserPoolId: userPoolId,
      })
      .promise();
    const email = userInfo.UserAttributes?.find(
      (attribute) => attribute.Name === "email"
    );

    if (email?.Value) {
      return email.Value;
    }

    throw new Error("Email not found");
  }

  isAdminUser(authorizer: APIGatewayEventDefaultAuthorizerContext): boolean {
    return authorizer?.claims?.scope.startsWith("admin");
  }
}
