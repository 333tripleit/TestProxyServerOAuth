const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const cookieParser = require('cookie-parser');


const fs = require('fs');
const path = require('path');
const sessionsDir = path.join(__dirname, 'sessions');
console.log('Sessions directory:', sessionsDir);
fs.mkdirSync(sessionsDir, { recursive: true });


const session = require('express-session');
const FileStore = require('session-file-store')(session);
dotenv.config();

const app = express();

const autoDeploy = false;
const jobQueue  = []; 
let isDeploying = false;

//const sessionsDir = path.resolve(process.cwd(), 'sessions');

const WEEK = 60 * 60 * 24 * 7

app.use(cors({
  origin: [
    'https://333tripleit.github.io',
    'https://333tripleit.github.io.'
  ],
  credentials: true
}));

app.use(cookieParser());         

app.set('trust proxy', 1);

app.use(session({
  name: 'sotn.sid',
    store: new FileStore({
    path: sessionsDir,
    ttl: WEEK,
    retries: 1
  }),
  secret: process.env.SESSION_SECRET || 'fallback-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
	maxAge: WEEK * 1000
//	domain: 'sotn2-auth-proxy.onrender.com'
  }
}));

app.use(express.json());


const CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const REDIRECT_URI = 'https://test-sotn2-auth-proxy.onrender.com/auth/callback';

app.get('/auth/login', (req, res) => {
  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=read:user,public_repo`;
  res.redirect(githubAuthUrl);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;

  const tokenRes = await axios.post(
    'https://github.com/login/oauth/access_token',
    {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code
    },
    {
      headers: { Accept: 'application/json' }
    }
  );

  const accessToken = tokenRes.data.access_token;


  const userRes = await axios.get('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });

  const username = userRes.data.login;

  console.log("Received code:", req.query.code);
  console.log("Access token:", accessToken);
  console.log("GitHub user:", username);
  console.log("Session before saving:", req.session);
  req.session.username = username;
  req.session.accessToken = accessToken;
  console.log("Session after saving:", req.session);
  req.session.save(err => {
    if (err) console.error(err);
    res.redirect('https://333tripleit.github.io');
  });
  
});

app.get('/auth/me', (req, res) => {
  if (!req.session.username) {
    return res.status(401).json({ authorized: false });
  }
  res.json({
    authorized: true,
    username: req.session.username
  });
});




function enqueueJob(job) {
  jobQueue.push(job);
  if (!isDeploying) processNextJob();
}

async function processNextJob() {
  if (isDeploying || jobQueue.length === 0) return;

  isDeploying = true;
  const { added, updated, deleted, owner, repo, path, branch, accessToken, username, res } = jobQueue.shift();

  try {
    const { newContent, sha } = await prepareCommit(added, updated, deleted, owner, repo, path, branch, accessToken);

    // 2) Запушить изменения
    await axios.put(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        message: `Update markers by ${username}`,
        content: newContent,
        sha,
        branch,
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    let status;
    do {
      await sleep(5000);
      status = await getPagesDeploymentStatus(accessToken, owner, repo);
    } while (status !== 'built' && status !== 'errored');
	    if (status === 'built') {
      res.json({ ok: true });
    } else {
      throw new Error('Deployment errored');
    }
  } catch (err) {
    console.error('Job failed:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    isDeploying = false;
    processNextJob();
  }
}





app.post('/api/update-markers', async (req, res) => {
  console.log('Update-markers body:', req.body);
  const { added, updated, deleted } = req.body;
  const { owner, repo, path, branch, accessToken, username } = extractFromSession(req);

  enqueueJob({ added, updated, deleted, owner, repo, path, branch, accessToken, username, res });
});


function extractFromSession (req) {
	const accessToken = req.session.accessToken;
	const owner = '333tripleit';
	const username = req.session.username;
	const repo  = '333tripleit.github.io';
	const path  = 'markers.json';
	const branch = 'main';
	return { owner, repo, path, branch, accessToken, username };
}

async function prepareCommit (added, updated, deleted, owner, repo, path, branch, accessToken) {
	const get = await axios.get(
	  `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
	  { headers: { Authorization: `Bearer ${accessToken}` },
	    params: { ref: branch }
	  }
	);
    const sha     = get.data.sha;
    const content = Buffer.from(get.data.content, 'base64').toString();
    const markers = JSON.parse(content);
	
	let merged = [...markers, ...added];
	
	merged = merged.map(m => {
	  const upd = updated.find(u => u.id === m.id);
	  return upd ? upd : m;
	});
	
	merged = merged.filter(m => !deleted.includes(m.id));
	
	//const newMarkers = markers
   //   .filter(m => !deleted.includes(m.id))
   //   .map(m => {
    //    const u = updated.find(x => x.id === m.id);
   //     return u ? u : m;
   //   });
    //newMarkers.push(...added);
	
    const newContent = Buffer.from(JSON.stringify(merged, null, 2)).toString('base64');
	return { newContent, sha };
}

async function getPagesDeploymentStatus (accessToken, owner, repo) {
    const builds = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pages/builds`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );
	const latest = builds.data[0];
	return latest.status;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/api/deploy-status', async (req, res) => {
  const accessToken = req.session.accessToken;
  const owner = '333tripleit';
  const repo  = '333tripleit.github.io';
  const builds = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/pages/builds`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const latest = builds.data[0];
  res.json({ status: latest.status });
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});