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

async function updateStatus(botToken, adminId, messageId, completedBatches, totalBatches, totalUsers, successCount, failedCount, errorBreakdown, currentPage, totalPages) {
  const { blocked, deleted, invalid, other } = errorBreakdown;
  const statusText = `🚀 *STATUS: LIVE*\n
Page *${currentPage}* out of *${totalPages}*\n
🔄 *Processing Batches:* ${completedBatches}/${totalBatches}\n
✅ *Successful Sent:* ${successCount}\n
😔 *Failed:* ${failedCount}\n
🔥 *Overall Status:*\n
👥 *Total Users:* ${totalUsers}\n
✅ *Total Successful Sent:* ${successCount}\n
⚠️ *ERROR MATRIX:*\n
❌ *Blocked:* ${blocked} || 🗑️ *Deleted:* ${deleted}\n
❓ *Invalid IDs:* ${invalid} || ⚙️ *Other:* ${other}\n
💻 *System Status:* ⚙️ *Running...*`;

  await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    chat_id: adminId,
    message_id: messageId,
    text: statusText,
    parse_mode: "Markdown"
  });
}

async function sendFinalStats(botToken, adminId, totalUsers, successCount, failedCount, errorBreakdown, logFilePath, messageId, formattedTime) {
  const { blocked, deleted, invalid, other } = errorBreakdown;
  const finalText = `✅ *Broadcast Complete!*\n
⏳ *Time Taken:* ${formattedTime}\n
👥 *Total Users:* ${totalUsers} | ✅ *Sent:* ${successCount}\n
😔 *Failed:* ${failedCount}\n
⚠️ *ERROR REPORT:*\n
❌ *Blocked:* ${blocked} || 🗑️ *Deleted:* ${deleted}\n
❓ *Invalid IDs:* ${invalid} || ⚙️ *Other:* ${other}\n
🎯 *System Status:* *Complete!* 😎`;

  await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    chat_id: adminId,
    message_id: messageId,
    text: finalText,
    parse_mode: "Markdown"
  });

  if (other) {
    const formData = new FormData();
    formData.append('chat_id', adminId);
    formData.append('document', fs.createReadStream(logFilePath));
    await axios.post(`https://api.telegram.org/bot${botToken}/sendDocument`, formData, {
      headers: formData.getHeaders()
    });
    fs.unlinkSync(logFilePath);
  } else {
    fs.unlinkSync(logFilePath); // Remove log file if no errors occurred
  }
}

async function sendMediaOrText(botToken, userId, params, errorBreakdown, logFilePath) {
    const { 
        type, text, caption, file_id, parse_mode = 'Markdown', 
        disable_web_page_preview = false, protect_content = false, 
        inline = [], pin = false  // Added pin parameter
    } = params;
    
    const commonData = {
        chat_id: userId,
        parse_mode,
        protect_content,
        reply_markup: { inline_keyboard: inline }
    };
    
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
        // Send the message
        const response = await axios.post(`https://api.telegram.org/bot${botToken}/${apiMethod}`, requestData);
        const messageId = response.data.result.message_id;  // Get the message ID from the response

        // If pin is true, pin the message
        if (pin) {
            await axios.post(`https://api.telegram.org/bot${botToken}/pinChatMessage`, {
                chat_id: userId,
                message_id: messageId
            });
        }

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

async function fetchUsersPage(botUsername, page) {
    const response = await axios.get(`https://api.teleservices.io/Broadcast/public/users.php?bot_username=${botUsername}&page=${page}`);
    return response.data;
}


app.all('/br', async (req, res) => {
  const startTime = Date.now();
  try {
    // Extract parameters from the request body or query
    const botToken = req.body.bot_token || req.query.bot_token;
    const adminId = req.body.admin_id || req.query.admin_id;
    const botUsername = req.body.bot_username || req.query.bot_username;

    const type = req.body.type || req.query.type;
    const text = req.body.text || req.query.text;
    const caption = req.body.caption || req.query.caption;
    const file_id = req.body.file_id || req.query.file_id;
    const parse_mode = req.body.parse_mode || req.query.parse_mode;
    const protect_content = req.body.protect_content || req.query.protect_content;
    const disable_web_page_preview = req.body.disable_web_preview || req.query.disable_web_preview;
    const inline = req.body.inline_keyboard || req.query.inline_keyboard;
    const pin = req.body.pin || req.query.pin;

    // Validate required parameters
    if (!botToken || !adminId || !botUsername || !type) {
      return res.status(400).json({ message: 'Missing required parameters.' });
    }

    const logFilePath = path.join(__dirname, 'broadcast_log.txt');
    fs.writeFileSync(logFilePath, '', 'utf8');

    let totalUsers = 0;
    let successCount = 0;
    let failedCount = 0;
    const errorBreakdown = { blocked: 0, deleted: 0, invalid: 0, other: 0 };
    let messageId = null;

    // Fetch the users from the first page
    const firstPageData = await fetchUsersPage(botUsername, 1);
    totalUsers = firstPageData.total_users;
    const totalPages = firstPageData.total_pages;
    const usersId = firstPageData.ids; // Assuming ids array is available here

    const batchSize = 25;
    const userBatches = chunkArray(usersId, batchSize);
    const totalBatches = userBatches.length;

    // Send initial status message with total users
    messageId = await sendInitialStatus(botToken, adminId, totalUsers, totalBatches, totalPages);

    // Process each page
    for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
      const pageData = await fetchUsersPage(botUsername, currentPage);
      const usersId = pageData.ids;
      const userBatches = chunkArray(usersId, batchSize);
      const pageTotalBatches = userBatches.length;

      let pageSuccessCount = 0;

      // Process each batch
      for (let i = 0; i < pageTotalBatches; i++) {
        const batch = userBatches[i];
        const batchSuccess = await sendMessageBatch(botToken, batch, { 
          type, text, caption, file_id, parse_mode, 
          disable_web_page_preview, protect_content, inline, pin
        }, errorBreakdown, logFilePath);
    
        pageSuccessCount += batchSuccess;
        successCount += batchSuccess;
        failedCount += batch.length - batchSuccess;
    
        // Update status for each page and batch
        await updateStatus(botToken, adminId, messageId, i + 1, pageTotalBatches, totalUsers, successCount, failedCount, errorBreakdown, currentPage, totalPages);
    
        // Add a 0.9-second delay before processing the next batch
        await delay(900);
      }
    }
    // Calculate the elapsed time for the broadcast
    const elapsedTime = Date.now() - startTime;
    const elapsedSeconds = Math.floor(elapsedTime / 1000);
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    const formattedTime = elapsedMinutes > 0
      ? `${elapsedMinutes}m ${elapsedSeconds % 60}s`
      : `${elapsedSeconds}s`;

    // Send final stats to the admin
    await sendFinalStats(botToken, adminId, totalUsers, successCount, failedCount, errorBreakdown, logFilePath, messageId, formattedTime);

    res.status(200).json({ message: 'Broadcast completed successfully.' });
  } catch (error) {
    console.error('Error during broadcast:', error);
    res.status(500).json({ message: 'Error during broadcast.', error: error.message });
  }
});

app.listen(8000, () => {
    console.log('Server running on port 80');
});
