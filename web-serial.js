export class BrowserSerial {
 constructor({serial=globalThis.navigator?.serial,secure=globalThis.isSecureContext,emit=()=>{},now=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout}={}){
  Object.assign(this,{serial,secure,emit,now,schedule,cancel});this.ports=[];this.port=null;this.generation=0;this.opening=null;this.polling=null;this.timer=null;this.armed=false;
  serial?.addEventListener('disconnect',e=>{if(e.target===this.port||e.port===this.port)this.fail(new Error('串口设备已拔出。'));});
 }
 supported(){if(!this.secure)throw new Error('串口访问需要 HTTPS，或本机 localhost 地址。');if(!this.serial)throw new Error('当前浏览器不支持 Web Serial，请使用支持串口的桌面浏览器（如 Chrome 或 Edge）。');}
 async list(){this.supported();this.ports=await this.serial.getPorts();return this.ports.map((p,i)=>({id:String(i),label:this.label(p,i)}));}
 label(p,i){const info=p.getInfo();const usb=info.usbVendorId?` · USB ${info.usbVendorId.toString(16).padStart(4,'0')}:${(info.usbProductId||0).toString(16).padStart(4,'0')}`:'';return `串口 ${i+1}${usb}`;}
 async choose(){this.supported();const p=await this.serial.requestPort();if(!this.ports.includes(p))this.ports.push(p);return String(this.ports.indexOf(p));}
 async connect(config){
  this.supported();if(this.port||this.opening)throw new Error('串口正在使用。');
  const generation=++this.generation;
  // requestPort must run directly in the user click, before unrelated awaits.
  const selection=this.ports[Number(config.port)]&&config.port!==''?Promise.resolve(this.ports[Number(config.port)]):this.serial.requestPort();
  const task=(async()=>{
   const port=await selection;if(generation!==this.generation)throw new Error('连接已取消。');
   if(!this.ports.includes(port))this.ports.push(port);
   this.emit({type:'selected',id:String(this.ports.indexOf(port)),label:this.label(port,this.ports.indexOf(port))});
   await port.open({baudRate:9600,flowControl:'none'});this.port=port;
   try{await port.setSignals({requestToSend:config.rtsHigh,dataTerminalReady:false});if(generation!==this.generation)throw new Error('连接已取消。');
    this.config=config;this.armed=false;this.lastDown=false;this.lastSample=null;this.lastRaw=null;this.lastReport=-Infinity;await this.sample(generation);
    if(generation!==this.generation)throw new Error('连接已取消。');
    this.emit({type:'status',connected:true,connecting:false,armed:this.armed});this.queue(generation);
    return {connected:true,armed:this.armed};
   }catch(e){await this.release();throw e;}
  })();this.opening=task;
  try{return await task;}finally{if(this.opening===task)this.opening=null;}
 }
 async sample(generation){
  const signals=await this.port.getSignals();if(generation!==this.generation)return;
  const t=this.now(),raw={cts:signals.clearToSend,dsr:signals.dataSetReady,cd:signals.dataCarrierDetect};
  if(Object.values(raw).some(v=>typeof v!=='boolean'))throw new Error('驱动未提供完整的 CTS / DSR / DCD 电平。');
  const down=raw[this.config.keyPin]!==this.config.keyLow;
  if(!this.armed&&!down)this.armed=true;
  const snapshot=JSON.stringify(raw)+this.armed;if(snapshot!==this.lastRaw){this.emit({type:'inputs',dot:down,dash:false,armed:this.armed,raw});this.lastRaw=snapshot;}
  if(this.lastSample!==null&&t-this.lastReport>=250){this.emit({type:'sampling',ms:t-this.lastSample});this.lastReport=t;}this.lastSample=t;
  if(this.armed&&down!==this.lastDown){this.lastDown=down;this.emit({type:'edge',down,t});}
 }
 queue(generation){this.timer=this.schedule(async()=>{
  if(generation!==this.generation)return;
  try{this.polling=this.sample(generation);await this.polling;if(generation===this.generation)this.queue(generation);}catch(e){await this.fail(e);}finally{this.polling=null;}
 },2);}
 async release(){const p=this.port;this.port=null;if(p){try{await p.setSignals({requestToSend:false,dataTerminalReady:false});}catch{}await p.close();}}
 async disconnect(){++this.generation;this.cancel(this.timer);if(this.opening)await this.opening.catch(()=>{});if(this.polling)await this.polling.catch(()=>{});await this.release();this.armed=false;this.emit({type:'status',connected:false,connecting:false,armed:false});}
 async fail(error){++this.generation;this.cancel(this.timer);try{await this.release();}catch{}this.emit({type:'status',connected:false,connecting:false,armed:false,message:`串口读取中断：${error.message}`});}
}
