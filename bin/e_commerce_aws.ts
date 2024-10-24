#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import "source-map-support/register";
import { ECommerceApiStack } from "../lib/ecommerceApi-stack";
import { ProductsAppStack } from "../lib/productsApp-stack";
import { ProductsAppLayersStack } from "../lib/productsAppLayers-stack";
import { EventsDdbStack } from "../lib/eventsDdb-stacks";
import { OrdersAppLayersStack } from "../lib/ordersAppLayers-stack";
import { OrdersAppStack } from "../lib/ordersApp-stack";
import { InvoiceWSApiStack } from "../lib/invoiceWSApi-stack";
import { InvoicesAppLayersStack } from "../lib/invoicesAppLayers-stack";
import { AuditEventBusStack } from "../lib/auditEventBus-stack";
import { AuthLayersStack } from "../lib/authLayers-stack";
const app = new cdk.App();

const env: cdk.Environment = {
  account: "211125622733",
  region: "us-east-1",
};

const tags = {
  cost: "ECommerce",
  team: "GuilhermeRibeiro",
};

const setTagEnv = { tags, env };

const auditEventBusStack = new AuditEventBusStack(app, "AuditEvents", {
  tags: {
    cost: "Audit",
    team: tags.team,
  },
  env,
});

const authLayerStack = new AuthLayersStack(app, "AuthLayers", {
  ...setTagEnv,
});

const productsAppLayersStack = new ProductsAppLayersStack(
  app,
  "ProductsAppLayers",
  {
    ...setTagEnv,
  }
);

const eventsDdbStack = new EventsDdbStack(app, "EventsDdb", {
  ...setTagEnv,
});

const productsAppStack = new ProductsAppStack(app, "ProductsApp", {
  ...setTagEnv,
  eventsDdb: eventsDdbStack.table,
});
productsAppStack.addDependency(productsAppLayersStack);
productsAppStack.addDependency(authLayerStack);
productsAppStack.addDependency(eventsDdbStack);

const ordersAppLayersStack = new OrdersAppLayersStack(app, "OrdersAppLayers", {
  ...setTagEnv,
});

const ordersAppStack = new OrdersAppStack(app, "OrdersApp", {
  ...setTagEnv,
  productsDdb: productsAppStack.productsDdb,
  eventsDdb: eventsDdbStack.table,
  auditBus: auditEventBusStack.bus,
});
ordersAppStack.addDependency(productsAppStack);
ordersAppStack.addDependency(ordersAppLayersStack);
ordersAppStack.addDependency(eventsDdbStack);
ordersAppStack.addDependency(auditEventBusStack);

const eCommerceApiStack = new ECommerceApiStack(app, "ECommerceApi", {
  productsFetchHandler: productsAppStack.productsFetchHandler,
  productsAdminHandler: productsAppStack.productsAdminHandler,
  ordersHandler: ordersAppStack.ordersHandler,
  orderEventsFetchHandler: ordersAppStack.orderEventsFetchHandler,
  ...setTagEnv,
});
eCommerceApiStack.addDependency(productsAppStack);
eCommerceApiStack.addDependency(ordersAppStack);

const invoicesAppLayersStack = new InvoicesAppLayersStack(
  app,
  "InvoicesAppLayers",
  {
    tags: {
      cost: "InvoiceApp",
      team: "GuilhermeRibeiro",
    },
    env,
  }
);
const invoiceWSApiStack = new InvoiceWSApiStack(app, "InvoiceApi", {
  eventsDdb: eventsDdbStack.table,
  auditBus: auditEventBusStack.bus,
  tags: {
    cost: "InvoiceApp",
    team: "GuilhermeRibeiro",
  },
  env,
});
invoiceWSApiStack.addDependency(invoicesAppLayersStack);
invoiceWSApiStack.addDependency(eventsDdbStack);
invoiceWSApiStack.addDependency(auditEventBusStack);
