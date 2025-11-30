// lib/exerbudPersistence.js
import { prisma } from './prisma.js';

export async function getOrCreateUser(identity) {
  const { userId, userEmail } = identity;

  if (!userId && !userEmail) {
    throw new Error('Missing user identity for Exerbud');
  }

  // Prefer externalId if present
  const where = userId
    ? { externalId: userId }
    : { email: userEmail };

  const data = {
    externalId: userId ?? undefined,
    email: userEmail ?? undefined,
  };

  const user = await prisma.user.upsert({
    where,
    update: { email: userEmail ?? undefined },
    create: data,
  });

  return user;
}

export async function getOrCreateConversation(params) {
  const { userId, workflow = null, reuseWindowMinutes = 60 } = params;

  const since = new Date(Date.now() - reuseWindowMinutes * 60 * 1000);

  const existing = await prisma.conversation.findFirst({
    where: {
      userId,
      createdAt: { gte: since },
      archived: false
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      userId,
      workflow,
      title: null,
    },
  });
}

export async function saveMessages({ conversationId, messages }) {
  if (!messages || messages.length === 0) return;

  await prisma.message.createMany({
    data: messages.map(m => ({
      conversationId,
      role: m.role,
      content: m.content,
      workflow: m.workflow ?? null,
    })),
  });
}

export async function saveUploads({ userId, conversationId, uploads }) {
  if (!uploads || uploads.length === 0) return;

  await prisma.upload.createMany({
    data: uploads.map(u => ({
      userId,
      conversationId,
      filename: u.filename,
      mimeType: u.mimeType,
      sizeBytes: u.sizeBytes,
      url: u.url ?? null,
      workflow: u.workflow ?? null,
    })),
  });
}
