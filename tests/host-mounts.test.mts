import test from 'node:test';
import assert from 'node:assert/strict';
import {hostMountPath} from '../server/src/executors/host-mounts.ts';
const mounts=[{Type:'volume',Source:'/var/lib/docker/volumes/custom-data/_data',Destination:'/data'},{Type:'bind',Source:'/srv/projects',Destination:'/workspaces'},{Type:'bind',Source:'/srv/special',Destination:'/workspaces/nested'}];
test('named volume and workspace binds use daemon paths rather than container paths',()=>{
 assert.equal(hostMountPath('/data/sessions/abc',mounts),'/var/lib/docker/volumes/custom-data/_data/sessions/abc');
 assert.equal(hostMountPath('/workspaces/demo',mounts),'/srv/projects/demo');
});
test('the deepest mount wins and prefix collisions/unmounted paths are rejected',()=>{
 assert.equal(hostMountPath('/workspaces/nested/demo',mounts),'/srv/special/demo');
 assert.throws(()=>hostMountPath('/data-other/sessions',mounts),/not backed/);
 assert.throws(()=>hostMountPath('/tmp/private',mounts),/not backed/);
});
