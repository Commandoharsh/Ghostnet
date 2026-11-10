import type { NetworkSnapshot } from "./types";
export function createDemoNetworkSnapshot(): NetworkSnapshot {
  const now = new Date().toISOString();
  const ids = ["GN-001","GN-002","GN-003","GN-004","GN-005","GN-006"];
  const labels = ["Command center","Rescue Alpha","Medical camp","Shelter North","Relay 05","Mobile unit"];
  const transports = ["simulator","lora","wifi","bluetooth","lora","wifi"] as const;
  const nodes = ids.map((id,i)=>({id,label:labels[i],status:(i===4?"degraded":"online") as "online"|"degraded",transport:transports[i],lastSeenAt:now}));
  const pairs = [["GN-001","GN-002"],["GN-001","GN-003"],["GN-001","GN-004"],["GN-001","GN-005"],["GN-001","GN-006"],["GN-002","GN-005"],["GN-003","GN-004"]];
  return { generatedAt:now, mode:"simulation", nodes, links:pairs.map(([source,target],i)=>({source,target,transport:i%2?"wifi":"lora",quality:i===3?0.38:0.82,simulated:true as const})) };
}
