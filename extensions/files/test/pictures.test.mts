import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderPictures } from '../src/pictures.ts';

const folder = '/workspaces/proj';
const url = (p: string) => `/api/sessions/s/picture?path=${encodeURIComponent(p)}`;

test('a picture in the folder is fetched through the portal, by a relative or an absolute path', () => {
  assert.equal(folderPictures('![chart](plots/chart.png)', folder, url), '![chart](</api/sessions/s/picture?path=plots%2Fchart.png>)');
  assert.equal(folderPictures('![a](/workspaces/proj/a.png "Title")', folder, url), '![a](</api/sessions/s/picture?path=a.png> "Title")');
  assert.equal(folderPictures('![s](<my plots/a b.png>)', folder, url), '![s](</api/sessions/s/picture?path=my%20plots%2Fa%20b.png>)');
  assert.equal(folderPictures('![s](my%20plots/a.png)', folder, url), '![s](</api/sessions/s/picture?path=my%20plots%2Fa.png>)');
});

test('addresses that already are one, and paths outside the folder, are left alone', () => {
  for (const text of ['![w](https://example.com/a.png)', '![d](data:image/png;base64,AAAA)', '![p](/api/sessions/s/images/x.png)', '![o](/etc/a.png)', '![u](../other/a.png)']) {
    assert.equal(folderPictures(text, folder, url), text);
  }
});

test('text around the pictures, and links that are not pictures, stay as they were', () => {
  const text = 'Before [link](a.png) and\n\n![one](a.png)\n\nafter ![two](b/c.gif).';
  assert.equal(folderPictures(text, folder, url), 'Before [link](a.png) and\n\n![one](</api/sessions/s/picture?path=a.png>)\n\nafter ![two](</api/sessions/s/picture?path=b%2Fc.gif>).');
});

test('in a file of a subfolder a relative path is read from that subfolder, and may not leave the folder', () => {
  assert.equal(folderPictures('![a](img/a.png)', folder, url, 'docs'), '![a](</api/sessions/s/picture?path=docs%2Fimg%2Fa.png>)');
  assert.equal(folderPictures('![a](../a.png)', folder, url, 'docs'), '![a](</api/sessions/s/picture?path=a.png>)');
  assert.equal(folderPictures('![a](/workspaces/proj/a.png)', folder, url, 'docs'), '![a](</api/sessions/s/picture?path=a.png>)');
  assert.equal(folderPictures('![a](../../a.png)', folder, url, 'docs'), '![a](../../a.png)');
});

test('Files passes the chat folder: an absolute path inside it is the file, one outside stays as written', () => {
  // The call as the panel makes it, for a file in the top of the folder.
  assert.equal(folderPictures('![a](/workspaces/proj/a.png)', folder, url, ''), '![a](</api/sessions/s/picture?path=a.png>)');
  assert.equal(folderPictures('![a](/etc/a.png)', folder, url, ''), '![a](/etc/a.png)');
  // An empty folder, as the panel once passed it, would have sent both under the folder.
  assert.notEqual(folderPictures('![a](/etc/a.png)', '', url, ''), '![a](/etc/a.png)');
});
