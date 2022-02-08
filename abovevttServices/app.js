// Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');
const { request } = require('http');

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
  if(action=="migrate"){
    console.log("GOT A MIGRATION REQUEST!");
    const campaignId=event.queryStringParameters?event.queryStringParameters.campaign:"";
    const scenes=JSON.parse(event.body);
    console.log(scenes);
    let requests=[];

    scenes.forEach(scene => {
      let fogData=scene.reveals;
      let drawData=scene.drawings;
      let tokens=scene.tokens;
      scene.reveals=[];
      scene.drawings=[];
      scene.tokens={};

      requests.push({
        PutRequest: {
          Item: {
            campaignId: campaignId,
            objectId: "scenes#"+scene.id+"#scenedata",
            sceneId: scene.id,
            data:scene,
            timestamp: Date.now(),
          }
        }
      });

      requests.push({
        PutRequest: {
          Item: {
            campaignId: campaignId,
            objectId: "scenes#"+scene.id+"#fogdata",
            data:fogData,
            timestamp: Date.now(),
          }
        }
      });

      requests.push({
        PutRequest: {
          Item: {
            campaignId: campaignId,
            objectId: "scenes#"+scene.id+"#drawings",
            data:drawData,
            timestamp: Date.now(),
          }
        }
      });

      for( tokenid in tokens){
        requests.push({
          PutRequest: {
            Item: {
              campaignId: campaignId,
              objectId: "scenes#"+scene.id+"#tokens#"+tokenid,
              data:tokens[tokenid],
              timestamp: Date.now(),
            }
          }
        });
      }
    });

    // and finally enable the cloud !
    requests.push({
      PutRequest: {
        Item: {
          campaignId: campaignId,
          objectId: "campaigndata",
          data:{
            cloud:1
          },
          timestamp: Date.now(),
        }
      }
    });

    console.log("preparing the batch writes");
    // NOW SEND THE REQUESTS with a super batch write
    let promises=[];
    for(let i=0;i<requests.length;i+=20){

      let currentBatch=requests.slice(i,i+21);
      console.log("adding batch with index "+i);
      console.log(currentBatch);
      let batchParams={
        RequestItems: { 
          abovevtt: currentBatch
        }
      }
      promises.push(ddb.batchWrite(batchParams).promise());
    }
    console.log(promises);
    await Promise.allSettled(promises).then(
      (results)=>{console.log(results);}
    );

    return { statusCode: 200, body: 'Migrated' };   
  } // END OF MIGRATE

  return { statusCode: 200, body: 'unknown action' };
};
