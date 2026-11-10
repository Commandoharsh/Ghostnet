export type QueueState = "queued" | "failed";
export interface QueuedMessage {
  id: string; senderId: string; destinationId: string; body: string;
  priority: "critical"|"high"|"normal"; createdAt: string; expiresAt: string; state: QueueState;
}
const DB_NAME = "ghostnet-offline";
const STORE = "outbox";
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request = indexedDB.open(DB_NAME,1);
    request.onupgradeneeded = () => { const db=request.result; if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE,{keyPath:"id"}); };
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
  });
}
export async function enqueueMessage(message: QueuedMessage): Promise<void> {
  const db=await openDb();
  await new Promise<void>((resolve,reject)=>{ const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).put(message); tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); });
  db.close();
}
export async function getQueuedMessages(): Promise<QueuedMessage[]> {
  const db=await openDb();
  const rows=await new Promise<QueuedMessage[]>((resolve,reject)=>{ const req=db.transaction(STORE,"readonly").objectStore(STORE).getAll(); req.onsuccess=()=>resolve(req.result as QueuedMessage[]); req.onerror=()=>reject(req.error); });
  db.close(); return rows;
}
async function deleteQueuedMessage(id:string):Promise<void>{
  const db=await openDb();
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction(STORE,"readwrite");tx.objectStore(STORE).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
  db.close();
}
async function updateQueuedMessage(message:QueuedMessage):Promise<void>{ await enqueueMessage(message); }

export async function syncOutbox(): Promise<{sent:number;pending:number;failed:number}> {
  const rows=await getQueuedMessages(); let sent=0,failed=0;
  for(const message of rows){
    if(Date.parse(message.expiresAt)<=Date.now()){await deleteQueuedMessage(message.id);continue;}
    try{
      const response=await fetch("/api/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(message)});
      if(response.ok){await deleteQueuedMessage(message.id);sent++;}
      else{await updateQueuedMessage({...message,state:"failed"});failed++;}
    }catch{await updateQueuedMessage({...message,state:"failed"});failed++;}
  }
  const remaining=(await getQueuedMessages()).length;
  return {sent,pending:remaining,failed};
}
