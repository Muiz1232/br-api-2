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
    const startingText = `🚀 Starting broadcast to ${totalUsers} users...`;
    const response = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: adminId,
        text: startingText,
        parse_mode: "Markdown"
    });
    return response.data.result.message_id;
}

async function updateStatus(botToken, adminId, messageId, completedBatches, totalBatches, totalUsers, successCount, errorBreakdown) {
    const { blocked, deleted, invalid, other } = errorBreakdown;
    const statusText = `🚀 *STATUS: LIVE*\n
🔄 *Processing Batches:* ${completedBatches}/${totalBatches}
👥 *Total Users:* ${totalUsers}
✅ *Successful Sent:* ${successCount}\n
⚠️ *ERROR MATRIX:*\n
❌ *Blocked:* ${blocked} || 🗑️ *Deleted:* ${deleted}
❓ *Invalid IDs:* ${invalid} || ⚙️ *Other:* ${other}\n
💻 *System Status:* ⚙️ *Running...*`;
    await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        chat_id: adminId,
        message_id: messageId,
        text: statusText,
        parse_mode: "Markdown"
    });
}

async function sendFinalStats(botToken, adminId, totalUsers, successCount, errorBreakdown, logFilePath, messageId) {
    const { blocked, deleted, invalid, other } = errorBreakdown;
    const finalText = `✅ *Broadcast Complete!*\n
👥 *Total Users:* ${totalUsers} | ✅ *Sent:* ${successCount}\n
⚠️ *ERROR REPORT:*\n
❌*Blocked Users:* ${blocked} || 🗑️ *Deleted:* ${deleted}
❓ *Invalid IDs:* ${invalid} || ⚙️ *Other:* ${other}\n
🎯 *System Status:* *Complete!* 😎`;
    await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        chat_id: adminId,
        message_id: messageId,
        text: finalText,
        parse_mode: "Markdown"
    });

    // Send log file only if there are errors
    if (other > 0) {
        const formData = new FormData();
        formData.append('chat_id', adminId);
        formData.append('document', fs.createReadStream(logFilePath));
        await axios.post(`https://api.telegram.org/bot${botToken}/sendDocument`, formData, {
            headers: formData.getHeaders()
        });
    }

    // Clean up log file
    if (fs.existsSync(logFilePath)) {
        fs.unlinkSync(logFilePath);
    }
}

async function sendMediaOrText(botToken, userId, params, errorBreakdown, logFilePath) {
    const { type, text, caption, file_id, parse_mode = 'Markdown', disable_web_page_preview = false, protect_content = false } = params;
    const commonData = { chat_id: userId, parse_mode, protect_content };
    let apiMethod, requestData;

    switch (type) {
        case 'text':
            if (!text) {
                logFailure(userId, 'Missing text for message type "text"', logFilePath);
                errorBreakdown.other += 1;
                return false;
            }
            apiMethod = 'sendMessage';
            requestData = { ...commonData, text, disable_web_page_preview };
            break;
        case 'photo':
            if (!file_id) {
                logFailure(userId, 'Missing file_id for message type "photo"', logFilePath);
                errorBreakdown.other += 1;
                return false;
            }
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
        default:
            logFailure(userId, `Unsupported media type: ${type}`, logFilePath);
            errorBreakdown.other += 1;
            return false;
    }

    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/${apiMethod}`, requestData);
        return true;
    } catch (error) {
        const { error_code, description } = error.response?.data || {};
        if (error_code === 429) {
            const retryAfter = error.response.data.parameters.retry_after || 1;
            await delay(retryAfter * 1000);
            return sendMediaOrText(botToken, userId, params, errorBreakdown, logFilePath);
        }

        if (error_code === 400 && description.includes("chat not found")) {
            errorBreakdown.invalid += 1;
        } else if (error_code === 403 && description.includes("bot was blocked by the user")) {
            errorBreakdown.blocked += 1;
        } else if (error_code === 403 && description.includes("user is deactivated")) {
            errorBreakdown.deleted += 1;
        } else {
            errorBreakdown.other += 1;
            logFailure(userId, `Other: ${description}`, logFilePath);
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
    try {
      const botToken = req.body.bot_token || req.query.bot_token;
      const adminId = req.body.admin_id || req.query.admin_id;
      
      let usersId = req.body.users_id || req.query.users_id;
      if (typeof usersId === 'string') {
          try {
              usersId = JSON.parse(usersId);
          } catch (error) {
              usersId = [];
          }
      }
      usersId = Array.isArray(usersId) ? usersId : [];
      
      const type = req.body.type || req.query.type;
      const text = req.body.text || req.query.text;
      const caption = req.body.caption || req.query.caption;
      const file_id = req.body.file_id || req.query.file_id;
      const parse_mode = req.body.parse_mode || req.query.parse_mode;
      const protect_content = req.body.protect_content || req.query.protect_content;
      const disable_web_page_preview = req.body.disable_web_page_preview || req.query.disable_web_page_preview;      

        if (!botToken || !adminId || !usersId || !type) {
            return res.status(400).json({ message: 'Missing required parameters.' });
        }

        const logFilePath = path.join(__dirname, 'broadcast_log.txt');
        fs.writeFileSync(logFilePath, '', 'utf8');

        const batchSize = 28;
        const userBatches = chunkArray(usersId, batchSize);
        const totalUsers = usersId.length;
        const totalBatches = userBatches.length;

        let successCount = 0;
        const errorBreakdown = { blocked: 0, deleted: 0, invalid: 0, other: 0 };
        const messageId = await sendInitialStatus(botToken, adminId, totalUsers);

        for (let i = 0; i < totalBatches; i++) {
            const batch = userBatches[i];
            const batchSuccess = await sendMessageBatch(botToken, batch, { type, text, caption, file_id, parse_mode, disable_web_page_preview, protect_content }, errorBreakdown, logFilePath);
            successCount += batchSuccess;
            await updateStatus(botToken, adminId, messageId, i + 1, totalBatches, totalUsers, successCount, errorBreakdown);
        }

        await sendFinalStats(botToken, adminId, totalUsers, successCount, errorBreakdown, logFilePath, messageId);
        res.status(200).json({ message: 'Broadcast completed successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Error during broadcast.', error: error.message });
    }
});

app.listen(80, () => {
    console.log('Server running on port 80');
});
