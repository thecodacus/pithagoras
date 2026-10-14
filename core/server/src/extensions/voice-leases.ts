/** Each tab owns a short lease; abandoned tabs expire without pinning GPU memory. */
export class VoiceLeases {
  private leases = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  constructor(private load:()=>Promise<void>, private unload:()=>Promise<void>, private now=Date.now) {}
  private serial<T>(task:()=>Promise<T>):Promise<T> {
    const next=this.queue.then(task,task);this.queue=next.catch(()=>{});return next;
  }
  acquire(key:string) {
    this.leases.set(key,this.now()+75000);
    return this.serial(async()=>{try{await this.load();this.loaded=true;}catch(e){this.leases.delete(key);throw e;}});
  }
  release(key:string,lazy=true) { this.leases.delete(key);return this.sweep(lazy); }
  sweep(lazy:boolean) {
    return this.serial(async()=>{
      for(const [key,expires] of this.leases)if(expires<=this.now())this.leases.delete(key);
      if(!lazy){await this.load();this.loaded=true;return;}
      if(!this.leases.size&&this.loaded){await this.unload();this.loaded=false;}
    });
  }
}
