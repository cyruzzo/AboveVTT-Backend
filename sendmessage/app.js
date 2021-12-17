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
    const postCalls = connectionData.Items.map(async ({ objectId,timestamp }) => {
      const connectionId= objectId.substring(5); // CONN#ID  to ID
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

// this function grabs the sceneLists, or it creates it if needed
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
    if(getReply.Items.length>0){
      console.log("DMjoin, found some scenes. I'll send them");
      console.log(getReply.Items)
      scenelist=getReply.Items.map( (element)=> element.data);
    }
    else{ // generate an empty scenelist
      console.log("generating empty scene");
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
        reveals: [[0, 0, 0, 0, 2, 0]]
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

    }

    // send the sceneList back to the DM
    const sceneListMsg={
      eventType: "custom/myVTT/scenelist",
      data: scenelist,
    }
    promises.push(apigwManagementApi.postToConnection({ ConnectionId: event.requestContext.connectionId, Data: JSON.stringify(sceneListMsg) }).promise());

    promises.push(
      get_current_scene_id(campaignId).then(
          (sceneId) => {
            console.log("The Current Scene id is "+ sceneId);
            return get_scene(campaignId,sceneId);
          }
      ).then(
        (sceneData)=>{
          console.log("sending back the message with the current scene data after a dmjoin")
          const message={
            eventType: "custom/myVTT/scene",
            data: sceneData.data,
          };
          return apigwManagementApi.postToConnection({ ConnectionId: event.requestContext.connectionId, Data: JSON.stringify(message) }).promise();
        }
      )
    );



    return Promise.allSettled(promises);
  });
}

async function get_scene(campaignId,sceneId){
  return ddb.query({
    TableName: process.env.TABLE_NAME,
    KeyConditionExpression: "campaignId = :hkey and begins_with(objectId,:skey)",
    ExpressionAttributeValues: {
      ':hkey': campaignId,
      ':skey': "scenes#"+sceneId
    },
  }).promise().then(function(data){ // STEP 2.1 PACK TOKENS INTO THE SCENE DATA
    console.log("got SceneData");
    console.log(data);
    let sceneData=data.Items.find( (element)=> element.objectId=="scenes#"+sceneId+"#scenedata");
    sceneData.data.tokens=[];
    data.Items.filter( (element)=> element.objectId.startsWith("scenes#"+sceneId+"#tokens#")).forEach((element)=>sceneData.data.tokens.push(element.data));


    sceneData.data.reveals=[]
    let fogdata=data.Items.find((element) => element.objectId=="scenes#"+sceneId+"#fogdata");
    if(fogdata && fogdata.data)
      sceneData.data.reveals=fogdata.data;
    sceneData.data.drawings=[]
    let drawdata=data.Items.find((element) => element.objectId=="scenes#"+sceneId+"#drawings");
    if(drawdata && drawdata.data)
    sceneData.data.drawings=drawdata.data;


    console.log("returning SceneData");
    return sceneData;
  });
}

async function get_current_scene_id(campaignId){
  return ddb.get({
    TableName: process.env.TABLE_NAME,
    Key: {
      campaignId: campaignId,
      objectId: "currentScene"
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
  console.log("executing switch_scene , searchign for " + campaignId + " and scene "+sceneId);

  return get_scene(campaignId,sceneId).then(function(sceneData){

    console.log(sceneData);

    return ddb.query({ // STEPE 2.2 AND GET ALL CONNECTIONS
      TableName: process.env.TABLE_NAME,
      KeyConditionExpression: "campaignId = :hkey and begins_with(objectId,:skey)",
      ExpressionAttributeValues: {
        ':hkey': campaignId,
        ':skey': "conn#"
      },
    }).promise().then(function(connectionData){ // STEP 3 CREATE THE "scene" MESSAGE AND SEND IT TO EVERYONE (including the sender)
      console.log("Got connectiondata");
      console.log(connectionData);
      const apigwManagementApi = new AWS.ApiGatewayManagementApi({
        apiVersion: '2018-11-29',
        endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
      });

      const message={
        eventType: "custom/myVTT/scene",
        data: sceneData.data,
      };

      const promises = connectionData.Items.map(async ({ objectId,timestamp }) => {
        const connectionId= objectId.substring(5); // CONN#ID  to ID
        const postCall=apigwManagementApi.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify(message) }).promise();
        return postCall.catch(function(e){ 
        });
      });

      // STEP 3.1 ALSO STORE THE CURRENT SCENE ID

      promises.push(
        ddb.put({
          TableName: process.env.TABLE_NAME,
          Item: {
            campaignId: campaignId,
            objectId: "currentScene",
            data: sceneId,
          }
        }).promise()
      );

      return Promise.allSettled(promises);
    });
  });

}

async function handle_player_join(event){
  const recvMessage=JSON.parse(event.body);
  const campaignId=recvMessage.campaignId;
  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
  });
  get_current_scene_id(campaignId).then(
    (sceneId) => {
      console.log("The Current Scene id is "+ sceneId);
      return get_scene(campaignId,sceneId);
    }
  ).then(
  (sceneData)=>{
    console.log("sending back the message with the current scene data after a dmjoin")
    const message={
      eventType: "custom/myVTT/scene",
      data: sceneData.data,
    };
    return apigwManagementApi.postToConnection({ ConnectionId: event.requestContext.connectionId, Data: JSON.stringify(message) }).promise();
  }
  );
}

// REQUEST HANDLER
exports.handler = async event => {
  const recvMessage=JSON.parse(event.body);
  if(recvMessage.eventType=="custom/myVTT/keepalive")
    return { statusCode: 200, body: 'Data sent.' };
  
  let doForwardMessage=true;
  const campaignId=recvMessage.campaignId;
  const promises=[];

  console.log("Campaign "+campaignId+" Event: "+recvMessage.eventType+ " requestTimeEpoch: " + event.requestContext.requestTimeEpoch);

  if(recvMessage.eventType=="custom/myVTT/dmjoin"){ // REPLY WITH THE SCENE LIST
    promises.push(sendSceneList(event));
  }

  if(recvMessage.eventType=="custom/myVTT/playerjoin"){ // REPLY WITH THE SCENE LIST
    promises.push(handle_player_join(event));
  }

  if(recvMessage.eventType=="custom/myVTT/switch_scene"){
    promises.push(switch_scene(event));
    doForwardMessage=false;
  }

  if(doForwardMessage)
    promises.push(forwardMessage(event)); // FORWARD THE MESSAGE TO ALL THE OTHER USERS

  // STORE/UPDATE TOKEN DATA IN DYNAMODB. JFF
  if(recvMessage.eventType=="custom/myVTT/token"){
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

  // STORE FOG
  if(recvMessage.eventType=="custom/myVTT/fogdata"){
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
  if(recvMessage.eventType=="custom/myVTT/drawdata"){
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

