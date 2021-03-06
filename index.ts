#!/usr/bin/env node
import {Architecture, AssetCode, Function, Runtime} from "@aws-cdk/aws-lambda";
import {CfnApi, CfnDeployment, CfnIntegration, CfnRoute, CfnStage, CorsHttpMethod, HttpApi, HttpMethod} from "@aws-cdk/aws-apigatewayv2";
import {HttpLambdaIntegration} from '@aws-cdk/aws-apigatewayv2-integrations';
import {App, ConcreteDependable, Construct, Duration, RemovalPolicy, Stack, StackProps} from '@aws-cdk/core';
import {Effect, PolicyStatement, Role, ServicePrincipal} from "@aws-cdk/aws-iam";
import {AttributeType, BillingMode, Table} from "@aws-cdk/aws-dynamodb";

import config from './config.json';

class ChatAppStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);
        const tableName = "abovevtt";

        // initialise api
        const name = id + "-api"
        const api = new CfnApi(this, name, {
            name: "AboveVTTBackend",
            protocolType: "WEBSOCKET",
            routeSelectionExpression: "$request.body.action",
        });

        const table = new Table(this, `${name}-table`, {
            tableName: tableName,
            partitionKey: {
                name: "campaignId",
                type: AttributeType.STRING,
            },
            sortKey:{
                name: "objectId",
                type: AttributeType.STRING
            },
            billingMode: BillingMode.PAY_PER_REQUEST,
            removalPolicy: RemovalPolicy.RETAIN,
        });

        table.addGlobalSecondaryIndex({
            indexName: "connectionIds",
            partitionKey: {
                name: "connectionId",
                type: AttributeType.STRING,
            },
        });

        table.addGlobalSecondaryIndex({
            indexName: "sceneProperties",
            partitionKey: {
                name: "campaignId",
                type: AttributeType.STRING,
            },
            sortKey:{
                name: "sceneId",
                type: AttributeType.STRING
            },
        });

        const httpApi = new HttpApi(this, 'HttpApi',{
            corsPreflight:{
                allowHeaders:[
                    'Content-Type',
                ],
                allowMethods: [
                    CorsHttpMethod.OPTIONS,
                    CorsHttpMethod.GET,
                    CorsHttpMethod.POST,
                    CorsHttpMethod.PUT,
                    CorsHttpMethod.PATCH,
                    CorsHttpMethod.DELETE,
                  ],
                allowOrigins:['*'],
            }
        });

        const abovevttServicesFunc = new Function(this,"abovevtt-services-lambda",{
            code: new AssetCode('./abovevttServices'),
            architecture: Architecture.X86_64,
            handler: 'app.handler',
            runtime: Runtime.NODEJS_12_X,
            timeout: Duration.seconds(30),
            memorySize: 256,
            environment: {
                "TABLE_NAME": tableName,
            }
        });
        table.grantReadWriteData(abovevttServicesFunc);

        const abovevttServicesIntegration=new HttpLambdaIntegration('abovevttServices',abovevttServicesFunc,{
        });

        httpApi.addRoutes({
            path: '/services',
            methods: [ HttpMethod.GET , HttpMethod.PUT, HttpMethod.POST],
            integration: abovevttServicesIntegration,
          });
        


        

        const connectFunc = new Function(this, 'connect-lambda', {
            code: new AssetCode('./onconnect'),
            handler: 'app.handler',
            runtime: Runtime.NODEJS_12_X,
            timeout: Duration.seconds(30),
            memorySize: 256,
            environment: {
                "TABLE_NAME": tableName,
            }
        });

        table.grantReadWriteData(connectFunc)

        const disconnectFunc = new Function(this, 'disconnect-lambda', {
            code: new AssetCode('./ondisconnect'),
            handler: 'app.handler',
            runtime: Runtime.NODEJS_12_X,
            timeout: Duration.seconds(30),
            memorySize: 256,
            environment: {
                "TABLE_NAME": tableName,
            }
        });

        table.grantReadWriteData(disconnectFunc)

        const keepaliveFunc = new Function(this, 'keepalive-lambda', {
            code: new AssetCode('./keepalive'),
            handler: 'app.handler',
            runtime: Runtime.NODEJS_12_X,
            timeout: Duration.seconds(2),
            memorySize: 128,
        });

        const messageFunc = new Function(this, 'message-lambda', {
            code: new AssetCode('./sendmessage'),
            handler: 'app.handler',
            runtime: Runtime.NODEJS_12_X,
            timeout: Duration.seconds(30),
            memorySize: 256,
            initialPolicy: [
                new PolicyStatement({
                    actions: [
                        'execute-api:ManageConnections'
                    ],
                    resources: [
                        "arn:aws:execute-api:" + config["region"] + ":" + config["account_id"] + ":" + api.ref + "/*"
                    ],
                    effect: Effect.ALLOW,
                })
            ],
            environment: {
                "TABLE_NAME": tableName,
            }
        });

        table.grantReadWriteData(messageFunc)

        // access role for the socket api to access the socket lambda
        const policy = new PolicyStatement({
            effect: Effect.ALLOW,
            resources: [
                connectFunc.functionArn,
                disconnectFunc.functionArn,
                messageFunc.functionArn,
                keepaliveFunc.functionArn,
            ],
            actions: ["lambda:InvokeFunction"]
        });

        const role = new Role(this, `${name}-iam-role`, {
            assumedBy: new ServicePrincipal("apigateway.amazonaws.com")
        });
        role.addToPolicy(policy);

        // lambda integration
        const connectIntegration = new CfnIntegration(this, "connect-lambda-integration", {
            apiId: api.ref,
            integrationType: "AWS_PROXY",
            integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + connectFunc.functionArn + "/invocations",
            credentialsArn: role.roleArn,
        })
        const disconnectIntegration = new CfnIntegration(this, "disconnect-lambda-integration", {
            apiId: api.ref,
            integrationType: "AWS_PROXY",
            integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + disconnectFunc.functionArn + "/invocations",
            credentialsArn: role.roleArn
        })
        const messageIntegration = new CfnIntegration(this, "message-lambda-integration", {
            apiId: api.ref,
            integrationType: "AWS_PROXY",
            integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + messageFunc.functionArn + "/invocations",
            credentialsArn: role.roleArn,
        })
        const keepaliveIntegration = new CfnIntegration(this, "keepalive-lambda-integration", {
            apiId: api.ref,
            integrationType: "AWS_PROXY",
            integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + keepaliveFunc.functionArn + "/invocations",
            credentialsArn: role.roleArn,
        })

        const connectRoute = new CfnRoute(this, "connect-route", {
            apiId: api.ref,
            routeKey: "$connect",
            authorizationType: "NONE",
            target: "integrations/" + connectIntegration.ref,
        });

        const disconnectRoute = new CfnRoute(this, "disconnect-route", {
            apiId: api.ref,
            routeKey: "$disconnect",
            authorizationType: "NONE",
            target: "integrations/" + disconnectIntegration.ref,
        });

        const messageRoute = new CfnRoute(this, "message-route", {
            apiId: api.ref,
            routeKey: "sendmessage",
            authorizationType: "NONE",
            target: "integrations/" + messageIntegration.ref,
        });

        const keepaliveRoute = new CfnRoute(this, "keepalive-route", {
            apiId: api.ref,
            routeKey: "keepalive",
            authorizationType: "NONE",
            target: "integrations/" + keepaliveIntegration.ref,
        });

        const deployment = new CfnDeployment(this, `${name}-deployment`, {
            apiId: api.ref
        });

        new CfnStage(this, `${name}-stage`, {
            apiId: api.ref,
            autoDeploy: true,
            deploymentId: deployment.ref,
            stageName: "v1"
        });

        const dependencies = new ConcreteDependable();
        dependencies.add(connectRoute)
        dependencies.add(disconnectRoute)
        dependencies.add(messageRoute)
        dependencies.add(keepaliveRoute);
        deployment.node.addDependency(dependencies);
    }
}
const app = new App();
new ChatAppStack(app, `abovevtt-backend`);
app.synth();