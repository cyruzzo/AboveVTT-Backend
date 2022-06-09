// YEP.. almost all the logic is here :)

const AWS = require('aws-sdk');
const { PRIORITY_ABOVE_NORMAL } = require('constants');

const ddb = new AWS.DynamoDB.DocumentClient({ apiVersion: '2012-08-10', region: process.env.AWS_REGION });

const { TABLE_NAME } = process.env;

function forwardMessage(event){
  console.log("ForwardMessage()");
  const recvMessage=JSON.parse(event.body);
  const campaignId=recvMessage.campaignId;
  const senderId=event.requestContext.connectionId;
  let connectionData={};

  return ddb.query({
    TableName: process.env.TABLE_NAME,
    KeyConditionExpression: "campaignId = :hkey and begins_with(objectId,:skey)",
    ExpressionAttributeValues: {
      ':hkey': campaignId,
      ':skey': "conn#"
    },
  }).promise().then(function(connectionData){
    console.log("OK. GOT THE CONNECTION DATA");
    console.log(connectionData);
    const apigwManagementApi = new AWS.ApiGatewayManagementApi({
      apiVersion: '2018-11-29',
      endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
    });
  
    let recvMessageEdit = JSON.parse(event.body);
    recvMessageEdit.requestTimeEpoch = String(event.requestContext.requestTimeEpoch);
    const eventBodySend = JSON.stringify(recvMessageEdit);
    
    let counter=0;
    const postCalls = connectionData.Items.map(async ({ objectId,connectionId,timestamp }) => {
      if(connectionId==senderId){
        return;
      }
      if(timestamp < Date.now()- (1000*60*120)){
        console.log(`Found expired connection, deleting ${connectionId}`)
        return ddb.delete({ TableName: TABLE_NAME, Key: { campaignId: campaignId, objectId: objectId } }).promise();
      }
  
      counter++;
      const postCall=apigwManagementApi.postToConnection({ ConnectionId: connectionId, Data: eventBodySend }).promise();
      return postCall.catch(function(e){
        if (e.statusCode === 410) {
          console.log(`Found stale connection, deleting ${connectionId}`);
          return ddb.delete({ TableName: TABLE_NAME, Key: { campaignId: campaignId, objectId: objectId } }).promise();
        }
      });
    });
    console.log("message queued for "+counter+" connections");
    return Promise.allSettled(postCalls);
  }).catch(function(){
    console.log('fuck. the query failed');
  });

}

// this function grabs the sceneLists, or it creates it if needed and also send the currente scene
async function sendSceneList(event){
  const recvMessage=JSON.parse(event.body);
  const campaignId=recvMessage.campaignId;
  const senderId=event.requestContext.connectionId;

  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
  });

  const queryParams ={
    TableName: process.env.TABLE_NAME,
    IndexName: 'sceneProperties',
    KeyConditionExpression: "campaignId = :hkey",
    ExpressionAttributeValues: {
      ':hkey': campaignId,
    },
  };

  let getSceneList = ddb.query(queryParams).promise();

  return getSceneList.then(function(getReply){
    let scenelist=[];

    let promises=[];
    let force_scene=null;

    if(getReply.Items.length>0){
      console.log("DMjoin, found some scenes. I'll send them");
      console.log(getReply.Items)
      scenelist=getReply.Items.map( (element)=> element.data);
    }
    else{ // generate an empty scenelist
      console.log("generating empty scene");
      force_scene=666;
      let basicScene={
        id:'666',
        title: "The Tavern",
        dm_map: "",
        player_map: "https://i.pinimg.com/originals/a2/04/d4/a204d4a2faceb7f4ae93e8bd9d146469.jpg",
        scale: "100",
        dm_map_usable: "0",
        fog_of_war: "1",
        tokens: {},
        grid: "0",
        hpps: "72",
        vpps: "72",
        snap: "1",
        fpsq: "5",
        offsetx: 29,
        offsety: 54,
        reveals: [[0, 0, 0, 0, 2, 0]],
        order: Date.now(),
      };
      
      scenelist=[basicScene];

      promises.push(
        ddb.put({
          TableName: process.env.TABLE_NAME,
          Item: {
            campaignId: campaignId,
            objectId: "scenes#"+basicScene.id+"#scenedata",
            sceneId: basicScene.id,
            data:basicScene,
            timestamp: Date.now(),
          }
        }).promise()
      );

      promises.push(ddb.put({ // also initialize fog data
        TableName: process.env.TABLE_NAME,
          Item: {
            campaignId: campaignId,
            objectId: "scenes#"+basicScene.id+"#fogdata",
            data: [[0, 0, 0, 0, 2, 0]],
          }
      }).promise());

      promises.push(
        ddb.put({
          TableName: process.env.TABLE_NAME,
          Item: {
            campaignId: campaignId,
            objectId: "dmscene",
            data: "666",
          }
        }).promise()
      );
      promises.push(
        ddb.put({
          TableName: process.env.TABLE_NAME,
          Item: {
            campaignId: campaignId,
            objectId: "playerscene",
            data: "666",
          }
        }).promise()
      )
    }


    // grab the current player scene so we can tell the DM where the players are!
    promises.push(get_current_scene_id(campaignId,false,force_scene).then(function(sceneid){
      // send the sceneList back to the DM
      const sceneListMsg={
        eventType: "custom/myVTT/scenelist",
        data: scenelist,
        playersSceneId: sceneid,
      }
      return apigwManagementApi.postToConnection({ ConnectionId: event.requestContext.connectionId, Data: JSON.stringify(sceneListMsg) }).promise();
    }));
      

    return Promise.allSettled(promises).then(
        () => get_current_scene_id(campaignId,true,force_scene)
      ).then(
        (sceneId) => {
          console.log("The Current Scene id is "+ sceneId);
          console.log("sending back the message with the current scene data after a dmjoin")
          const message={
            eventType: "custom/myVTT/fetchscene",
            data: {sceneid:sceneId},
          };
          return apigwManagementApi.postToConnection({ ConnectionId: event.requestContext.connectionId, Data: JSON.stringify(message) }).promise();
        }
      );
  });
}

async function delete_scene(event){
  const recvMessage=JSON.parse(event.body);
  const campaignId=recvMessage.campaignId;

  const sceneId=recvMessage.data.id;
  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
  });
  console.log("deleting...");
  return ddb.query({
    TableName: process.env.TABLE_NAME,
    KeyConditionExpression: "campaignId = :hkey and begins_with(objectId,:skey)",
    ExpressionAttributeValues: {
      ':hkey': campaignId,
      ':skey': "scenes#"+sceneId
    },
    ProjectionExpression: "objectId"
  }).promise().then(
    function (sceneData){
      console.log("got the list of objects to delete ");
      console.log("I have to delete " + sceneData.Items.length + "objects");
      let promises=[];
      for(let i=0;i<sceneData.Items.length;i=i+25){
        let batch_requests=[];

        for (let j=i; (j<(i+25)) && (j<sceneData.Items.length) ;j++  ){
          batch_requests.push({
            DeleteRequest : {
              Key : {
                  campaignId:campaignId,
                  objectId: sceneData.Items[j].objectId,
              }
          }
          });
        }

        let batch_params={
          RequestItems: {
            "abovevtt": batch_requests
          }
        };

        promises.push(ddb.batchWrite(batch_params).promise());
      }
      return Promise.allSettled(promises);
    }
  );
}

async function get_current_scene_id(campaignId,get_dm_scene,forced=null){
  if(forced!=null)
    return forced;
  let objectId="";
  if(get_dm_scene)
    objectId="dmscene";
  else
    objectId="playerscene";

  return ddb.get({
    TableName: process.env.TABLE_NAME,
    Key: {
      campaignId: campaignId,
      objectId: objectId
    }
  }).promise().then(function(data){
    if(data.Item){
      console.log("found the current scene");
      return data.Item.data;
    }
    else{
      console.log("didn't found the current scene");
      return null;
    }
  });
}


async function switch_scene(event){
  const recvMessage=JSON.parse(event.body);
  const sceneId=recvMessage.data.sceneId;
  const campaignId=recvMessage.campaignId;

  const switch_dm=recvMessage.data.switch_dm?true:false;

  console.log("executing switch_scene , searchign for " + campaignId + " and scene "+sceneId);

  return ddb.query({ // STEPE 1 get All connections based on DM / PLAYER SWITCH
    TableName: process.env.TABLE_NAME,
    KeyConditionExpression: "campaignId = :hkey and begins_with(objectId,:skey)",
    ExpressionAttributeValues: {
      ':hkey': campaignId,
      ':skey': "conn#" + (switch_dm ? "DM#" : "PLAYERS#")
    },
  }).promise().then(function (connectionData) { 
    // STEP 2.1 CREATE THE "scene" MESSAGE AND SEND IT TO EVERYONE (including the sender if needed)
    console.log("Got connectiondata");
    console.log(connectionData);
    const apigwManagementApi = new AWS.ApiGatewayManagementApi({
      apiVersion: '2018-11-29',
      endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
    });

    const message = {
      eventType: "custom/myVTT/fetchscene",
      data: {
        sceneid: sceneId
      },
    };

    const promises = connectionData.Items.map(async ({ objectId, connectionId, timestamp }) => {
      const postCall = apigwManagementApi.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify(message) }).promise();
      return postCall.catch(function (e) {
      });
    });

    // STEP 2.2 ALSO STORE THE CURRENT SCENE ID
    promises.push(
      ddb.put({
        TableName: process.env.TABLE_NAME,
        Item: {
          campaignId: campaignId,
          objectId: switch_dm ? "dmscene" : "playerscene",
          data: sceneId,
        }
      }).promise()
    );

    return Promise.allSettled(promises);
  });
}

async function update_scene(event){
  const recvMessage=JSON.parse(event.body);
  const campaignId=recvMessage.campaignId;
  let promises=[];
  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
  });

  const objectId="scenes#"+recvMessage.data.id+"#scenedata";

  if(recvMessage.data.isnewscene){
    delete recvMessage.data.isnewscene;
    promises.push(ddb.put({ // also initialize fog data
      TableName: process.env.TABLE_NAME,
        Item: {
          campaignId: campaignId,
          objectId: "scenes#"+recvMessage.data.id+"#fogdata",
          data: [[0, 0, 0, 0, 2, 0]],
        }
    }).promise());
  }

  promises.push(ddb.put({
    TableName: process.env.TABLE_NAME,
    Item: {
       campaignId: campaignId,
       objectId: objectId,
       data: recvMessage.data,
       sceneId: recvMessage.data.id
    }
  }).promise());

  const switch_dm = recvMessage.data.id === recvMessage.sceneId;

  if (switch_dm) {
    console.log("forcing dm update fater update_scene");
    let fakeEventBody={
      campaignId: recvMessage.campaignId,
      data: {
        sceneId: recvMessage.data.id,
        switch_dm: true
      }
    };
    let fakeEvent=Object.assign({}, event);
    fakeEvent.body=JSON.stringify(fakeEventBody);
    promises.push(switch_scene(fakeEvent));
  }

  const switch_players = recvMessage.data.id === recvMessage.playersSceneId;
  if (switch_players) {
    console.log("forcing players update after update_scene");
    let fakeEventBody={
      campaignId: recvMessage.campaignId,
      data: {
        sceneId: recvMessage.data.id
      }
    };
    let fakeEvent=Object.assign({}, event);
    fakeEvent.body=JSON.stringify(fakeEventBody);
    promises.push(switch_scene(fakeEvent));
  }

  return Promise.allSettled(promises).then((statuses)=>{console.log("statuses from update_scene");console.log(statuses)});
}


async function handle_player_join(event){
  const recvMessage=JSON.parse(event.body);
  const campaignId=recvMessage.campaignId;
  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
  });

  return get_current_scene_id(campaignId,false).then((sceneId) => {
    console.log("sending back the message with the current scene data after a playerjoin")
    const message={
      eventType: "custom/myVTT/fetchscene",
      data: {sceneid:sceneId},
    };
    return apigwManagementApi.postToConnection({ ConnectionId: event.requestContext.connectionId, Data: JSON.stringify(message) }).promise();
  });
}

// REQUEST HANDLER
exports.handler = async event => {
  const recvMessage=JSON.parse(event.body);
  if(recvMessage.eventType=="custom/myVTT/keepalive")
    return { statusCode: 200, body: 'Data sent.' };
  
  let doForwardMessage=true;
  const campaignId=recvMessage.campaignId;
  const isCloud=recvMessage.cloud == 1;
  const promises=[];

  console.log("Campaign "+campaignId+" Event: "+recvMessage.eventType+ " requestTimeEpoch: " + event.requestContext.requestTimeEpoch);

  if(isCloud && (recvMessage.eventType=="custom/myVTT/dmjoin")){ // REPLY WITH THE SCENE LIST
    promises.push(sendSceneList(event));
  }

  if(isCloud && (recvMessage.eventType=="custom/myVTT/playerjoin")){ // REPLY WITH THE SCENE LIST
    console.log("got a player join!");
    promises.push(handle_player_join(event));
  }

  if(isCloud && (recvMessage.eventType=="custom/myVTT/switch_scene")){
    promises.push(switch_scene(event));
    doForwardMessage=false;
  }

  // STORE/UPDATE TOKEN DATA IN DYNAMODB. JFF
  if(isCloud && (recvMessage.eventType=="custom/myVTT/token")){
    const objectId="scenes#"+recvMessage.sceneId+"#tokens#"+recvMessage.data.id;
    const putParams = {
      TableName: process.env.TABLE_NAME,
      Item: {
        campaignId: campaignId,
        objectId: objectId,
        data: recvMessage.data,
        timestamp: Date.now(),
      }
    };
    promises.push(ddb.put(putParams).promise());
  }

  // DELETE TOKEN
  if(isCloud && (recvMessage.eventType=="custom/myVTT/delete_token")){
    const objectId="scenes#"+recvMessage.sceneId+"#tokens#"+recvMessage.data.id;
    const delParams = {
      TableName: process.env.TABLE_NAME,
      Key: {
        campaignId: campaignId,
        objectId: objectId,
      }
    };
    promises.push(ddb.delete(delParams).promise());
  }

  if(isCloud && (recvMessage.eventType=="custom/myVTT/delete_scene")){
    promises.push(delete_scene(event));
  }

  // STORE FOG
  if(isCloud && (recvMessage.eventType=="custom/myVTT/fogdata")){
    const objectId="scenes#"+recvMessage.sceneId+"#fogdata";
    const putParams = {
      TableName: process.env.TABLE_NAME,
      Item: {
        campaignId: campaignId,
        objectId: objectId,
        data: recvMessage.data,
        timestamp: Date.now(),
      }
    };
    promises.push(ddb.put(putParams).promise());
  }

  // STORE DRAWINGS
  if(isCloud && (recvMessage.eventType=="custom/myVTT/drawdata")){
    const objectId="scenes#"+recvMessage.sceneId+"#drawdata";
    const putParams = {
      TableName: process.env.TABLE_NAME,
      Item: {
        campaignId: campaignId,
        objectId: objectId,
        data: recvMessage.data,
        timestamp: Date.now(),
      }
    };
    promises.push(ddb.put(putParams).promise());
  }
// 
  if(isCloud && (recvMessage.eventType=="custom/myVTT/update_scene")){ // THIS WILL CREATE OR UPDATE A SCENE (AND OPTIONALLY FORCE A SYNC FOR THE PLAYERS)
    promises.push(update_scene(event));
    doForwardMessage=false;
  }

  if(doForwardMessage)
    promises.push(forwardMessage(event)); // FORWARD THE MESSAGE TO ALL THE OTHER USERS


  try {
    await Promise.allSettled(promises);
  } catch (err) {
    console.log('Oh Oh. Something wrong');
    console.log(err);
    return { statusCode: 500, body: 'Failed to connect: ' + JSON.stringify(err) };
  }
  console.log("finished");
  return { statusCode: 200, body: 'Data sent.' };  
}

