// Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');

const ddb = new AWS.DynamoDB.DocumentClient({ apiVersion: '2012-08-10', region: process.env.AWS_REGION });

exports.handler = async event => {

  const campaignId=event.queryStringParameters?event.queryStringParameters.campaign:"";

  const isDM=event.queryStringParameters && event.queryStringParameters.DM;


  let objectid="";
  if(isDM){
    objectId="conn#DM#"+event.requestContext.connectionId;
  }
  else{
    objectId="conn#PLAYERS#"+event.requestContext.connectionId;
  }
  console.log("Adding "+objectId +" to "+campaignId);
  const putParams = {
    TableName: process.env.TABLE_NAME,
    Item: {
      campaignId: campaignId,
      objectId: objectId,
      connectionId: event.requestContext.connectionId,
      timestamp: Date.now(),
    }
  };

  try {
    let result = await ddb.put(putParams).promise();
    console.log("done?");
    console.log(result);
  } catch (err) {
    return { statusCode: 500, body: 'Failed to connect: ' + JSON.stringify(err) };
  }

  return { statusCode: 200, body: 'Connected.' };
};
