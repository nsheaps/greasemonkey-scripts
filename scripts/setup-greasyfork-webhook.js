#!/usr/bin/env node

const https = require("https");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const questions = [
  "Enter your GreasyFork API key: ",
  "Enter your GitHub repository URL (e.g., https://github.com/username/repo): ",
  "Enter your GitHub webhook secret: ",
];

const answers = [];

function askQuestion(index) {
  if (index === questions.length) {
    setupWebhook(answers[0], answers[1], answers[2]);
    return;
  }

  rl.question(questions[index], (answer) => {
    answers.push(answer);
    askQuestion(index + 1);
  });
}

function setupWebhook(apiKey, repoUrl, secret) {
  const options = {
    hostname: "greasyfork.org",
    path: "/en/users/webhook-info",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  };

  const data = JSON.stringify({
    repository_url: repoUrl,
    webhook_secret: secret,
  });

  const req = https.request(options, (res) => {
    let responseData = "";

    res.on("data", (chunk) => {
      responseData += chunk;
    });

    res.on("end", () => {
      if (res.statusCode === 200) {
        console.log("Webhook setup successful!");
      } else {
        console.error("Error setting up webhook:", responseData);
      }
      rl.close();
    });
  });

  req.on("error", (error) => {
    console.error("Error:", error);
    rl.close();
  });

  req.write(data);
  req.end();
}

console.log("GreasyFork Webhook Setup");
console.log("------------------------");
askQuestion(0);
