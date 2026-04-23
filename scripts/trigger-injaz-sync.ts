import { inngest } from '../apps/web/lib/inngest';

const approvedTaskIds = [
  'be835e29-643f-4c32-bce2-9e647932eba6',
  'f43f2fd2-d9ea-46b1-949f-56c147872689',
  '1c7c0534-319c-42b6-8e10-bfdb65e5499b',
  '1eabe00f-b8ea-4d0d-80f4-fef601d2a3f2',
  '7a1e25a3-dc4f-4c8d-b199-75224882562e',
  '2d043bc7-3728-4077-9c25-289f06b515a3',
  '8ea0149d-ab1b-44b4-b0c4-56739e92d58e',
];

async function main() {
  console.log('Triggering Injaz sync for approved tasks...');
  
  for (const taskId of approvedTaskIds) {
    try {
      await inngest.send({
        name: 'nexus/injaz.sync.requested',
        data: { proposedTaskId: taskId },
      });
      console.log(`✓ Sync triggered for task ${taskId}`);
    } catch (error) {
      console.error(`✗ Failed to trigger sync for task ${taskId}:`, error);
    }
  }
  
  console.log('Done!');
}

main().catch(console.error);
