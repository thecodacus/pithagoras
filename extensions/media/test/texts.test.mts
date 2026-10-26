import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerTools } from '../src/server/pi/tools.ts';
import { openStore, putSetting } from '../src/server/store.ts';
import { scratch } from '../../../tests/helpers.mts';

/**
 * What Media's tools cost in every request: their description and their schema. Written for a model that reads each
 * token before it can answer, so a text that grows back fails here. The caps are the lengths agreed for each when they
 * were the portal's (a quarter of a token to the character, as in the review of issue #183), with 10 for a changed
 * word; edit_image's is two less, for its description names Media's page in Settings now, which is shorter. The shape
 * that depends on a setting is looked at as well: several pictures to an edit, and generate_image with references,
 * which it has while editing is ready too (and its cost is that of the shape it has then; without editing it is the
 * agreed one, unchanged).
 */
openStore(path.join(scratch('media-texts-'), 'media.db'));
/** The tools a chat's pi is given as the settings are now. */
const registered = () => {
  const tools: any[] = [];
  registerTools({ registerTool: (tool: any) => tools.push(tool) }, { id: 's', title: '', workspace: '/nowhere', status: 'idle' });
  return tools;
};
putSetting('image_generation', JSON.stringify({ enabled: true, baseUrl: 'https://images.example.com/v1', editEnabled: true, editMultiple: false }));
putSetting('video_generation', JSON.stringify({ enabled: true, baseUrl: 'https://videos.example.com/v1' }));
const tools = registered();
const references = tools.find((tool) => tool.name === 'generate_image');
putSetting('image_generation', JSON.stringify({ enabled: true, baseUrl: 'https://images.example.com/v1', editEnabled: true, editMultiple: true }));
const several = registered().find((tool) => tool.name === 'edit_image');
const severalReferences = registered().find((tool) => tool.name === 'generate_image');
putSetting('image_generation', JSON.stringify({ enabled: true, baseUrl: 'https://images.example.com/v1' }));
const plain = registered().find((tool) => tool.name === 'generate_image');
const tokens = (text: string) => Math.ceil(text.length / 4);
const cost = (tool: any) => tokens(tool.description) + tokens(JSON.stringify(tool.parameters)) + (tool.promptSnippet ? tokens(`- ${tool.name}: ${tool.promptSnippet}`) : 0);
const ROOM = 10;
const AGREED: Record<string, number> = {
  generate_image: 143,
  'generate_image#references': 242,
  'generate_image#several references': 242,
  edit_image: 316,
  'edit_image#several': 383,
  generate_video: 317,
  show_image: 105,
  show_video: 105,
};

test('each Media tool costs no more than was agreed', () => {
  const all: [string, any][] = [
    ...tools.filter((tool) => tool.name !== 'generate_image').map((tool): [string, any] => [tool.name, tool]),
    ['generate_image', plain],
    ['generate_image#references', references],
    ['generate_image#several references', severalReferences],
    ['edit_image#several', several],
  ];
  assert.deepEqual(all.map(([key]) => key).sort(), Object.keys(AGREED).sort());
  for (const [key, tool] of all) assert.ok(cost(tool) <= AGREED[key] + ROOM, `${key} costs ${cost(tool)}, agreed ${AGREED[key]}`);
});

/**
 * What a spoken conversation was told of each while they were the portal's: show_image's sentence of the default voice
 * instructions, and the lines said of the others while they were registered. The same words, each tool's own now.
 */
const SAID: Record<string, string[] | undefined> = {
  show_image: ['To show the user a picture, chart, diagram or screenshot, save it as a PNG, JPEG, GIF or WebP in the chat folder and call show_image.'],
  generate_image: ['To make a new picture from a description, call generate_image: it saves the picture in the chat folder and shows it, so do not call show_image on it afterwards.'],
  edit_image: ['To change a picture in the chat folder, call edit_image: it saves the result as a new picture and shows it, so do not call show_image on it afterwards.'],
  generate_video: ['A video made with generate_video is not shown in a spoken conversation, only in the chat, and takes minutes: make one only when the person asks for it, and say that it will be in the chat.'],
  show_video: undefined,
};

test('what is said for spoken turns is said by each tool of itself, in the words the portal said it in, and only there', () => {
  for (const tool of [...tools, several, plain]) {
    assert.deepEqual(tool.voiceGuidelines, SAID[tool.name], tool.name);
    assert.equal(tool.promptGuidelines, undefined, tool.name);
  }
});
