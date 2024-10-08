import { ApiGatewayManagementApi } from "aws-sdk";

export class InvoiceWSService {
  private apigwManagementApi: ApiGatewayManagementApi;

  constructor(apigwManagementApi: ApiGatewayManagementApi) {
    this.apigwManagementApi = apigwManagementApi;
  }

  sendInvoiceStatus(
    transactionId: string,
    connectionId: string,
    status: string
  ) {
    const postData = JSON.stringify({
      transactionId,
      status,
    });

    return this.sendData(connectionId, postData);
  }

  async disconnectionClient(connectionId: string): Promise<boolean> {
    try {
      await this.apigwManagementApi
        .getConnection({
          ConnectionId: connectionId,
        })
        .promise();

      await this.apigwManagementApi
        .deleteConnection({
          ConnectionId: connectionId,
        })
        .promise();

      return true;
    } catch (error) {
      console.error("Error disconnecting client WebSocket: ", error);
      return false;
    }
  }

  async sendData(connectionId: string, data: string): Promise<boolean> {
    try {
      await this.apigwManagementApi
        .getConnection({
          ConnectionId: connectionId,
        })
        .promise();

      await this.apigwManagementApi
        .postToConnection({
          ConnectionId: connectionId,
          Data: data,
        })
        .promise();

      return true;
    } catch (error) {
      console.error("Error sending data to WebSocket: ", error);
      return false;
    }
  }
}
