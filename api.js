const { Telegraf } = require('telegraf');
const fs = require('fs');
const { exec } = require('child_process');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();

const config = require(`${__dirname}/config.json`);

const dir = '/Users/nikitakaluzhniy/projects/TelegramCircle';
const botToken = config.botToken;
const channelId = config.channelId;

const bot = new Telegraf(botToken);
const dbPath = `${dir}/v2vn.db`;

fs.mkdirSync(dir, { recursive: true });

const initDB = () => {
    if (!fs.existsSync(dbPath)) {
        const db = new sqlite3.Database(dbPath);
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                user_id TEXT,
                full_name TEXT,
                username TEXT,
                count TEXT,
                timestamp INTEGER
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY,
                user_id TEXT,
                file_id TEXT,
                timestamp INTEGER
            )`);
        });
        db.close();
    }
};

initDB();

const cropVideo = (newPath, userId) => {
    return new Promise((resolve, reject) => {
        const timestamp = Math.floor(Date.now() / 1000);
        const outputDir = `${dir}/temp/download/${userId}/`;
        fs.mkdirSync(outputDir, { recursive: true });
        const outPath = `${outputDir}/output_${timestamp}.mp4`;
        const ffmpegCmd = `ffmpeg -i ${newPath} -t 15  -c:a aac -c:v libx264 -filter:v "crop=min(iw\\,ih):min(iw\\,ih),scale=512:-1,crop=512:512" -crf 26 -y ${outPath}`;
        exec(ffmpegCmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error cropping video: ${error.message}`);
                reject(error);
            } else {
                console.log('Video cropped successfully');
                resolve(outPath);
            }
        });
    });
};

const getUser = (ctx) => {
    const { first_name, last_name, username, id } = ctx.message.from;
    const fullname = last_name ? `${first_name} ${last_name}` : first_name;
    const player = username ? `${fullname} @${username}(${id})` : `${fullname}(${id})`;
    return player;
};

const logging = (event) => {
    const now = new Date().toISOString().replace('T', ' ').substr(0, 19);
    const logFile = `${dir}/vnotebot.log`;
    fs.appendFileSync(logFile, `[${now}] ${event}\n`);
    console.log(`${event}`);
};

const addUser = (ctx) => {
    const { first_name, last_name, username, id, date } = ctx.message.from;
    const fullname = last_name ? `${first_name} ${last_name}` : first_name;
    const timestamp = Math.floor(date / 1000);

    const db = new sqlite3.Database(dbPath);
    db.serialize(() => {
        db.get('SELECT count(user_id) FROM users WHERE user_id=?', [id], (err, row) => {
            if (err) {
                console.error(err.message);
            }
            const record = row ? row['count(user_id)'] : 0;
            const userExists = record > 0;
            if (!userExists) {
                db.run('INSERT INTO users (user_id, full_name, username, timestamp, count) VALUES (?, ?, ?, ?, 0)', [id, fullname, username, timestamp], (err) => {
                    if (err) {
                        console.error(err.message);
                    } else {
                        const player = getUser(ctx);
                        logging(`${player} Registered.`);
                    }
                });
            }
        });
    });
    db.close();
};

bot.on('video', async (ctx) => {
    if (ctx.chat.type === 'private') {
        const userId = ctx.message.from.id;

        addUser(ctx);

        const fileSize = ctx.message.video.file_size;
        if (fileSize < 20971520) {
            try {
                const editLater = await bot.telegram.sendMessage(ctx.chat.id, 'Downloading...').then((sentMessage) => sentMessage.message_id);
                const fileLink = await bot.telegram.getFileLink(ctx.message.video.file_id);
                const newPath = `${dir}/${ctx.message.video.file_id}.mp4`;
                
                const downloadStream = fs.createWriteStream(newPath);
                https.get(fileLink, response => {
                    response.pipe(downloadStream);
                });

                await new Promise((resolve, reject) => {
                    downloadStream.on('finish', resolve);
                    downloadStream.on('error', reject);
                });

                try {
                    await bot.telegram.editMessageText(ctx.chat.id, editLater, null, 'Cropping video...');
                } catch (error) {
                    console.error(error.message);
                }

                const sendVideo = await cropVideo(newPath, userId);

                try {
                    await bot.telegram.editMessageText(ctx.chat.id, editLater, null, 'Sending back...');
                    const videoFile = fs.readFileSync(sendVideo);
                    await ctx.replyWithVideoNote({ source: videoFile });
                    await bot.telegram.sendVideo(channelId, { source: videoFile });
                    fs.unlinkSync(sendVideo);
                } catch (error) {
                    console.error(error.message);
                }

                try {
                    await bot.telegram.deleteMessage(ctx.chat.id, editLater);
                } catch (error) {
                    console.error(error.message);
                }

                const db = new sqlite3.Database(dbPath);
                db.serialize(() => {
                    db.run('UPDATE users SET count=COALESCE(count, 0) + 1 WHERE user_id=?', [userId]);
                    const timestamp = Math.floor(ctx.message.date / 1000);
                    db.run('INSERT INTO files (user_id, file_id, timestamp) VALUES (?, ?, ?)', [userId, ctx.message.video.file_id, timestamp]);
                });
                db.close();
                const player = getUser(ctx);
                logging(`${player} Made a video_note.`);
            } catch (error) {
                console.error(error.message);
            }
        } else {
            await ctx.reply('File too big. Send video smaller than 20M.');
            const player = getUser(ctx);
            logging(`${player} Sent a file bigger than 20MB.`);
        }
    }
});

bot.command('start', (ctx) => {
    ctx.reply('Just send me video!');
    addUser(ctx);
});

bot.launch().then(() => {
    console.log('Bot started');
}).catch((error) => {
    console.error(error.message);
});
