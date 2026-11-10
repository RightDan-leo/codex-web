import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { TranscriptionService } from "../server/transcription.js";

async function fixture(t: test.TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"transcript-receipt-"));
  let resolve!: (text:string)=>void, reject!: (error:Error)=>void, calls=0, source="";
  const pending=new Promise<string>((a,b)=>{resolve=a;reject=b;});
  t.mock.method(TranscriptionService.prototype,"transcribe",function(this:TranscriptionService,name:string) {
    calls++;source=path.join(this.audioRoot,name);return pending;
  });
  const app=createApp({projectRoot:process.cwd(),dataRoot:path.join(root,"data"),tenantRoot:path.join(root,"tenants"),username:"owner",passwordHash:bcrypt.hashSync("receipt-test",4),sessionSecret:"receipt-test-session-secret-more-than32characters",queueAutoStart:false});
  t.after(async()=>{resolve("saved words");app.beginShutdown();await app.waitForBackgroundTasks();app.db.close();fs.rmSync(root,{recursive:true,force:true});});
  const agent=request.agent(app.app);
  const login=await agent.post("/api/auth/login").send({username:"owner",password:"receipt-test"}).expect(200);
  const id=crypto.randomUUID();
  const send=(audio="fake audio")=>agent.post("/api/transcriptions").set("X-CSRF-Token",login.body.csrfToken)
    .field("clientRecordingId",id).field("async","true").field("conversationId","").field("projectId","")
    .field("draftText","").field("purpose","composer").field("attachmentNames","[]")
    .attach("audio",Buffer.from(audio),{filename:"recording.webm",contentType:"audio/webm"});
  const status=()=>agent.get(`/api/transcriptions/recordings/${id}`);
  return {app,agent,id,send,status,resolve,reject,calls:()=>calls,source:()=>source};
}
test("ASR upload acknowledges before completion and persisted result survives lost response",async t=>{
  const f=await fixture(t);
  await f.status().expect(404);
  await f.send().expect(202);
  assert.equal(fs.existsSync(f.source()),true,"202 must retain audio while ASR reads it");
  assert.equal((await f.status().expect(202)).body.state,"processing");
  await f.send().expect(202);assert.equal(f.calls(),1);
  await f.send("different bytes").expect(409);
  f.resolve("saved words");await f.app.waitForBackgroundTasks();
  const result=await f.status().expect(200);
  assert.equal(result.body.state,"succeeded");assert.equal(result.body.text,"saved words");
  assert.equal(result.headers["cache-control"],"no-store");
  const again=await f.send().expect(200);assert.equal(again.body.transcriptionId,result.body.transcriptionId);assert.equal(f.calls(),1);
  assert.equal(fs.existsSync(f.source()),false);
  await request(f.app.app).get(`/api/transcriptions/recordings/${f.id}`).expect(401);
  const foreignId=crypto.randomUUID();
  f.app.db.createUser({id:foreignId,username:"another",display_name:"Another",password_hash:bcrypt.hashSync("receipt-test",4),role:"member",status:"active",created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
  const foreign=request.agent(f.app.app);
  await foreign.post("/api/auth/login").send({username:"another",password:"receipt-test"}).expect(200);
  await foreign.get(`/api/transcriptions/recordings/${f.id}`).expect(404);
  await f.agent.get("/api/transcriptions/recordings/not-a-uuid").expect(400);
});
test("detached ASR failure becomes a queryable failed receipt",async t=>{
  const f=await fixture(t);await f.send().expect(202);f.reject(new Error("fixture provider timeout"));await f.app.waitForBackgroundTasks();
  const result=await f.status().expect(200);assert.equal(result.body.state,"failed");assert.match(result.body.error,/fixture provider timeout/);
  assert.equal(fs.existsSync(f.source()),false);
});
