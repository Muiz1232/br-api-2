const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function chunkArray(array, size) {
    return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
        array.slice(i * size, i * size + size)
    );
}

function logFailure(userId, reason, logFilePath) {
    const logEntry = `User ID: ${userId} | Reason: ${reason}\n`;
    fs.appendFileSync(logFilePath, logEntry, 'utf8');
}

async function sendInitialStatus(botToken, adminId, totalUsers) {
    const startingText = `🚀 **Broadcast Initiation:**\n
📡 **Preparing Transmission...**\n
👥 **Total Users:** ${totalUsers}\n
✅ **Messages Sent:** 0\n
❌ **Failures:** 0\n
\n🛠️ **Status:** Initializing... 🌟`;

    const response = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: adminId,
        text: startingText
    });
    return response.data.result.message_id;
}

async function updateStatus(botToken, adminId, messageId, completedBatches, totalBatches, totalUsers, successCount, errorBreakdown) {
    const { blocked, deleted, invalid, other } = errorBreakdown;
    const statusText = `🤖🚀 **BROADCAST PROGRESS**\n
📡 **Transmission Update:**\n
   ▶️ **Batches Completed:** ${completedBatches} / ${totalBatches}\n
   👥 **Total Users:** ${totalUsers}\n
   📨 **Messages Sent:** ✅ ${successCount}\n
\n⚠️ **Failure Details:**\n
   ❌ **Blocked:** ${blocked}\n
   🗑️ **Deleted Accounts:** ${deleted}\n
   ❓ **Invalid IDs:** ${invalid}\n
   ⚙️ **Other Errors:** ${other}\n
\n💻 **Status:** In Progress... 🚀`;
    await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        chat_id: adminId,
        message_id: messageId,
        text: statusText
    });
}

async function sendFinalStats(botToken, adminId, totalUsers, successCount, errorBreakdown, logFilePath, messageId) {
    const { blocked, deleted, invalid, other } = errorBreakdown;
    const finalText = `✅ **BROADCAST COMPLETE**\n
🎉 **Mission Summary:**\n
   👥 **Total Users:** ${totalUsers}\n
   📨 **Messages Successfully Sent:** ✅ ${successCount}\n
\n⚠️ **Failure Breakdown:**\n
   ❌ **Blocked:** ${blocked}\n
   🗑️ **Deleted Accounts:** ${deleted}\n
   ❓ **Invalid IDs:** ${invalid}\n
   ⚙️ **Other Errors:** ${other}\n
\n🤖 **Operation Status:** Complete! 🎯`;
    await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        chat_id: adminId,
        message_id: messageId,
        text: finalText
    });
    const formData = new FormData();
    formData.append('chat_id', adminId);
    formData.append('document', fs.createReadStream(logFilePath));
    await axios.post(`https://api.telegram.org/bot${botToken}/sendDocument`, formData, {
        headers: formData.getHeaders()
    });
    fs.unlinkSync(logFilePath);
}

async function sendMediaOrText(botToken, userId, params, errorBreakdown, logFilePath) {
  const { type, text, caption, file_id, parse_mode = 'Markdown', disable_web_page_preview = false, protect_content = false } = params;
  const commonData = { chat_id: userId, parse_mode, protect_content };
  let apiMethod, requestData;

  switch (type) {
    case 'text':
      apiMethod = 'sendMessage';
      requestData = { ...commonData, text, disable_web_page_preview };
      break;
    case 'photo':
      apiMethod = 'sendPhoto';
      requestData = { ...commonData, photo: file_id, caption };
      break;
    case 'video':
      apiMethod = 'sendVideo';
      requestData = { ...commonData, video: file_id, caption };
      break;
    case 'document':
      apiMethod = 'sendDocument';
      requestData = { ...commonData, document: file_id, caption };
      break;
    case 'audio':
      apiMethod = 'sendAudio';
      requestData = { ...commonData, audio: file_id, caption };
      break;
    case 'voice':
      apiMethod = 'sendVoice';
      requestData = { ...commonData, voice: file_id, caption };
      break;
    case 'sticker':
      apiMethod = 'sendSticker';
      requestData = { ...commonData, sticker: file_id };
      break;
    case 'animation':
      apiMethod = 'sendAnimation';
      requestData = { ...commonData, animation: file_id, caption };
      break;
    case 'video_note':
      apiMethod = 'sendVideoNote';
      requestData = { ...commonData, video_note: file_id };
      break;
    case 'voice_note':
      apiMethod = 'sendVoiceNote';
      requestData = { ...commonData, voice_note: file_id };
      break;
    default:
      logFailure(userId, 'Unsupported media type', logFilePath);
      errorBreakdown.other += 1;
      return false;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/${apiMethod}`, requestData);
    return true;
} catch (error) {
    if (error.response) {
        const { error_code, description, parameters } = error.response.data;

        if (error_code === 429 && parameters && parameters.retry_after) {
            await delay(parameters.retry_after * 1000);
            return sendMediaOrText(botToken, userId, params, errorBreakdown, logFilePath);
        }

        if (error_code === 400 && description.includes("chat not found")) {
            errorBreakdown.invalid += 1; // Invalid ID
        } else if (error_code === 403 && description.includes("bot was blocked by the user")) {
            errorBreakdown.blocked += 1; // Blocked
        } else if (error_code === 403 && description.includes("user is deactivated")) {
            errorBreakdown.deleted += 1; // Deleted
        } else {
            // Log only unclassified errors
            errorBreakdown.other += 1;
            logFailure(userId, `Other: ${description}`, logFilePath);
        }
    } else {
        // Log network or unexpected errors
        errorBreakdown.other += 1;
        logFailure(userId, `Other: ${error.message}`, logFilePath);
    }
    return false;
}
}
async function sendMessageBatch(botToken, userBatch, params, errorBreakdown, logFilePath) {
    let success = 0;
    const promises = userBatch.map(async userId => {
        const isSuccess = await sendMediaOrText(botToken, userId, params, errorBreakdown, logFilePath);
        if (isSuccess) success += 1;
    });
    await Promise.all(promises);
    return success;
}

app.all('/br', async (req, res) => {
    const botToken = req.query.bot_token || req.body.bot_token;
    const adminId = req.query.admin_id || req.body.admin_id;
    let usersId = req.query.users_id || req.body.users_id;
    const text = req.query.text || req.body.text;
    const type = req.query.type || req.body.type;
    const caption = req.query.caption || req.body.caption;
    const fileId = req.query.file_id || req.body.file_id;
    const parseMode = req.query.parse_mode || req.body.parse_mode;
    const protectContent = req.query.protect_content || req.body.protect_content;
    const disableWebPagePreview = req.query.disable_web_preview || req.body.disable_web_preview;

    if (!botToken || !adminId || !usersId || !text || !type) {
        return res.status(400).json({ message: 'Missing required parameters.' });
    }

    if (typeof usersId === 'string') {
        try {
            usersId = JSON.parse(usersId);
        } catch {
            return res.status(400).json({ message: 'Invalid users_id format. Should be an array or JSON string.' });
        }
    }

    if (!Array.isArray(usersId)) {
        return res.status(400).json({ message: 'users_id must be an array.' });
    }

    const logFilePath = path.join(__dirname, `broadcast_failures_${Date.now()}.txt`);
    fs.writeFileSync(logFilePath, 'Broadcast Failure Details:\n\n', 'utf8');

    const batchSize = 20;
    const parallelLimit = 5;
    const userBatches = chunkArray(usersId, batchSize);
    const totalUsers = usersId.length;
    const totalBatches = userBatches.length;

    let successCount = 0;
    const errorBreakdown = { blocked: 0, deleted: 0, invalid: 0, other: 0 };

    try {
        const messageId = await sendInitialStatus(botToken, adminId, totalUsers);

        for (let i = 0; i < totalBatches; i += parallelLimit) {
            const currentBatches = userBatches.slice(i, i + parallelLimit);

            const results = await Promise.all(
                currentBatches.map(batch => sendMessageBatch(botToken, batch, { type, text, caption, file_id: fileId, parse_mode: parseMode, disable_web_page_preview: disableWebPagePreview, protect_content: protectContent }, errorBreakdown, logFilePath))
            );

            successCount += results.reduce((sum, count) => sum + count, 0);
            await updateStatus(botToken, adminId, messageId, i + currentBatches.length, totalBatches, totalUsers, successCount, errorBreakdown);
        }

        await sendFinalStats(botToken, adminId, totalUsers, successCount, errorBreakdown, logFilePath,messageId);
        res.status(200).json({ message: 'Broadcast completed successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Error during broadcast.', error: error.message });
    } finally {
    if (fs.existsSync(logFilePath)) {
        fs.unlinkSync(logFilePath);
    }
}
});

// Start server
const PORT = 80;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
