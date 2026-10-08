import type { ImageUpload, TimelineFileAttachment, TimelineSkillMention, UserInput } from '../api/client';
import type { ChatClient } from './client';

export function nativeComposerInput(input: UserInput[], attachments: TimelineFileAttachment[], images: ImageUpload[], mentions: TimelineSkillMention[]): Omit<Parameters<ChatClient['queue']>[0], 'chatId'> {
  if (input.some(value => !['text', 'localImage', 'skill'].includes(value.type))) throw new Error('This input type is not connected to the native backend yet.');
  const skills = input.flatMap(value => value.type === 'skill' ? [{ name: value.name, path: value.path }] : []);
  return { text: input.flatMap(value => value.type === 'text' ? [value.text] : []).join('\n'),
    ...(images.length && { images }),
    ...(attachments.length && { files: attachments.map(file => ({ ...file, absolutePath: file.absolutePath ?? '', mimeType: file.mimeType ?? null })) }),
    ...(skills.length && { skills }),
    ...(mentions.length && { skillMentions: mentions.map(({ name, path, start, end }) => ({ name, path, start, end })) }),
  };
}
