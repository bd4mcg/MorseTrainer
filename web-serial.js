export class BrowserSerial {
 constructor({serial=globalThis.navigator?.serial,emit=()=>{},now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  this.serial=serial;this.emit=emit;this.now=now;this.sleep=sleep;this.ports=[];this.generation=0;
  serial?.addEventListener('disconnect',e=>{if(e.target===this.port||e.port===this.port)this.disconnect().catch(e=>this.emit({type:'warning',message:e.message}));});
 }
 check(){if(!this.serial)throw new Error('请使用桌面 Chrome / Edge，并通过 HTTPS 或 localhost 打开网页。');}
 async list(){this.check();for(const p of await this.serial.getPorts())if(!this.ports.includes(p))this.ports.push(p);return this.ports.map((p,i)=>{const info=p.getInfo();return {id:String(i),label:`已授权串口 ${i+1}${info.usbVendorId?` · USB ${info.usbVendorId.toString(16).padStart(4,'0')}:${(info.usbProductId||0).toString(16).padStart(4,'0')}`:''}`};});}
 connect(config){
  this.check();if(this.pending||this.port)throw new Error('串口正在连接或已连接，请先断开。');
  const epoch=++this.generation;
  // requestPort must run synchronously within the click, before any await.
  let selection;try{selection=this.ports[Number(config.port)]&&config.port!==''?Promise.resolve(this.ports[Number(config.port)]):this.serial.requestPort({});}catch(e){throw new Error(`选择串口失败：${e.name}: ${e.message}`,{cause:e});}
  const task=this.open(selection,config,epoch);this.pending=task;
  task.finally(()=>{if(this.pending===task)this.pending=null;}).catch(()=>{});return task;
 }
 async open(selection,c,epoch){
  let p,opened=false,stage='选择串口';
  try{
   p=await selection;if(epoch!==this.generation)return {connected:false};
   if(!this.ports.includes(p))this.ports.push(p);
   stage='打开串口';await p.open({baudRate:9600,dataBits:8,stopBits:1,parity:'none',flowControl:'none'});opened=true;
   if(epoch!==this.generation){await p.close();return {connected:false};}
   stage='设置 RTS / DTR';await p.setSignals({requestToSend:!!c.rtsHigh,dataTerminalReady:false});
   stage='首次读取电平';const initial=await p.getSignals();
   if(epoch!==this.generation){await p.close();return {connected:false};}
   this.port=p;this.config=c;this.armed=false;this.stable=null;this.candidate=null;this.samples=0;this.previous=null;this.changes={cts:0,dsr:0,cd:0};this.lastSample=null;this.maxInterval=0;this.lastReport=-Infinity;
   stage='更新连接状态';this.emit({type:'status',connected:true,connecting:false,armed:false});
   stage='处理首次电平';this.sample(initial);this.loopTask=this.loop(epoch);
   return {connected:true,armed:this.armed};
  }catch(e){if(opened)try{await p.close();}catch{};if(epoch!==this.generation)return {connected:false};
   if(this.port===p)this.port=null;
   throw new Error(e.name==='NotFoundError'?'未选择串口。':`${stage}失败：${e.name}: ${e.message}`,{cause:e});
  }
 }
 sample(signals){
  const t=this.now(),raw={cts:signals.clearToSend,dsr:signals.dataSetReady,cd:signals.dataCarrierDetect};
  if(Object.values(raw).some(x=>typeof x!=='boolean'))throw new Error('浏览器未返回完整的 CTS / DSR / DCD 电平');
  if(this.lastSample!==null)this.maxInterval=Math.max(this.maxInterval,t-this.lastSample);this.lastSample=t;this.samples++;
  for(const k of Object.keys(raw))if(this.previous&&this.previous[k]!==raw[k])this.changes[k]++;
  const changed=!this.previous||Object.keys(raw).some(k=>raw[k]!==this.previous[k]);this.previous=raw;
  const down=this.config.keyLow?!raw[this.config.keyPin]:raw[this.config.keyPin];
  if(down!==this.candidate){this.candidate=down;this.candidateAt=t;}
  if(t-this.candidateAt>=3&&this.stable!==down){
   this.stable=down;
   if(!this.armed&&!down){this.armed=true;this.emit({type:'armed',message:'输入就绪，请开始拍发。'});}
   else if(this.armed)this.emit({type:'edge',down,t:this.candidateAt});
  }
  if(changed||t-this.lastReport>=250){
   this.lastReport=t;this.emit({type:'inputs',raw,dot:down,dash:false,armed:this.armed});
   this.emit({type:'diagnostic',samples:this.samples,changes:{...this.changes},maxInterval:this.maxInterval,rts:this.config.rtsHigh});
  }
 }
 async loop(epoch){
  try{while(epoch===this.generation){await this.sleep(2);if(epoch!==this.generation)break;const value=await this.port.getSignals();if(epoch===this.generation)this.sample(value);}}
  catch(e){if(epoch===this.generation){this.emit({type:'warning',message:`读取电平失败：${e.message}`});void this.disconnect();}}
 }
 async disconnect(){
  ++this.generation;
  // A chooser cannot be dismissed programmatically; cancellation invalidates it.
  await this.loopTask;this.loopTask=null;
  const p=this.port;if(p){await p.close();this.port=null;}
  this.emit({type:'status',connected:false,connecting:false,armed:false});return {connected:false};
 }
}
