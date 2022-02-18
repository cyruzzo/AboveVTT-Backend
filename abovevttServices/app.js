// Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');
const { request } = require('http');

const ddb = new AWS.DynamoDB.DocumentClient({ apiVersion: '2012-08-10', region: process.env.AWS_REGION });


async function getAllData(params){
  const _getAllData = async (params, startKey) => {
    if (startKey) {
      params.ExclusiveStartKey = startKey
    }
    return this.documentClient.query(params).promise()
  }
  let lastEvaluatedKey = null
  let rows = []
  do {
    const result = await _getAllData(params, lastEvaluatedKey)
    rows = rows.concat(result.Items)
    lastEvaluatedKey = result.LastEvaluatedKey
  } while (lastEvaluatedKey)
  return rows
}







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

    let nextorder=1000000;
    scenes.forEach(scene => {
      let fogData=scene.reveals;
      let drawData=scene.drawings;
      let tokens=scene.tokens;
      scene.reveals=[];
      scene.drawings=[];
      scene.tokens={};

      if(!scene.order){
        scene.order=nextorder;
        nextorder=nextorder+1000000;
      }

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
            objectId: "scenes#"+scene.id+"#drawdata",
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

  if(action=="export_scenes"){
    const campaignId=event.queryStringParameters?event.queryStringParameters.campaign:"";
    const queryParams ={
      TableName: process.env.TABLE_NAME,
      IndexName: 'sceneProperties',
      KeyConditionExpression: "campaignId = :hkey",
      ExpressionAttributeValues: {
        ':hkey': campaignId,
      },
    };

    return ddb.query(queryParams).promise().then((queryReply)=>{
      let export_data=[];
      let scenelist=queryReply.Items.map( (element)=> element.data);

      let promises=[];
      scenelist.forEach(
        (scene)=>{
          
          let sceneId=scene.id;
          scene.tokens={};
          scene.reveals=[];
          scene.drawings=[];
          let readScenePromise=ddb.query({
            TableName: process.env.TABLE_NAME,
            KeyConditionExpression: "campaignId = :hkey and begins_with(objectId,:skey)",
            ExpressionAttributeValues: {
              ':hkey': campaignId,
              ':skey': "scenes#"+sceneId
            },
          }).promise().then(
          (sceneObjects)=>{ // this contains all tokens, reveals etc etc. we pack it in the scene
            // add tokens to scene
            console.log("got those sceneObjects");
            console.log(sceneObjects);
            console.log("for this scene");
            console.log(scene);
            sceneObjects.Items.filter( (element)=> element.objectId.startsWith("scenes#"+sceneId+"#tokens#")).forEach((element)=>scene.tokens[element.data.id]=element.data);

            // add fog
            let fogdata=sceneObjects.Items.find((element) => element.objectId=="scenes#"+sceneId+"#fogdata");
            if(fogdata && fogdata.data)
              scene.reveals=fogdata.data;
            console.log("got this fog");
            console.log(fogdata);
            let drawdata=sceneObjects.Items.find((element) => element.objectId=="scenes#"+sceneId+"#drawdata");

            if(drawdata && drawdata.data)
              scene.drawings=drawdata.data;
            
            export_data.push(scene);
          });
          promises.push(readScenePromise);
        }
      );

      return Promise.allSettled(promises).then(
        ()=>{
          return { statusCode: 200, body: JSON.stringify(export_data) };
        }
      );

    });
    
  }





  return { statusCode: 200, body: 'unknown action' };
};
