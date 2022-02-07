// Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');

const ddb = new AWS.DynamoDB.DocumentClient({ apiVersion: '2012-08-10', region: process.env.AWS_REGION });

exports.handler = async event => {
  
  const action=event.queryStringParameters?event.queryStringParameters.action:"";

  if(action=="getCampaignData"){
    const campaignId=event.queryStringParameters?event.queryStringParameters.campaign:"";
    return ddb.get({
      TableName: process.env.TABLE_NAME,
      Key: {
        campaignId: campaignId,
        objectId: 'campaigndata'
      }
    }).promise().catch(function(){
      return {};
    });
  }

  if(action=="setCampaignData"){
    const campaignId=event.queryStringParameters?event.queryStringParameters.campaign:"";
    console.log("logging full event diocane");
    console.log(event);
    const campaignData=JSON.parse(event.body);

    return ddb.put({
      TableName: process.env.TABLE_NAME,
      Item: {
        campaignId: campaignId,
        objectId: "campaigndata",
        data: campaignData,
        timestamp: Date.now(),
      }
    }).promise();
  }

  return { statusCode: 200, body: 'unknown action' };
};
