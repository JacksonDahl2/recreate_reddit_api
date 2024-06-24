const playwright = require("playwright")
const logger = require("./logger");
const queue = require("./sqs")

const connectionUrl = process.env.CONNECTION_URL

const addPageInterceptors = async (page) => {
  await page.route("**/*", (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    if (
      resourceType === "image" ||
      resourceType === "font" ||
      resourceType === "stylesheet" ||
      resourceType === "script" ||
      resourceType === "media" 
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });
};

const getAttributes = async (handle) => {
  handle.evaluate((element) => {
    const attributeMap = {};
    for (const attr of element.attributes) {
      attributeMap[attr.name] = attr.value;
    }
    return attributeMap;
  });
};

async function parseComment(e) {
  const things = await e.$$("> .sidtetable > .thing");
  let comments = []; 

  for (const thing of things) {
    let thingClass = await things[0].getAttribute("class");
    let children = await parseComment(await thing.$(".child"));
    let isDeleted = thingClass.includes("deleted");
    let author = isDeleted
      ? ""
      : await thing.$.eval(".author", (el) => el.innerText);
    let time = await thing.$eval("time", (el) => el.getAttribute("datetime"));
    let comment = isDeleted
      ? ""
      : await thing.$eval("$div.md", (el) => el.innerText.trim());
    let points = isDeleted
      ? ""
      : await thing.$eval("span.score", (el) => el.innerText.trim());

    comments.push({ author, time, comment, points, children, isDeleted });
  }
  return comments;
}

async function getDataForPosts(posts) {
  return await Promise.all(
    posts.map(async (post) => {
      let browser = await playwright.chromium.connectOverCDP(connectionUrl);
      let context = await browser.newContext();
      let page = await context.newPage();

      const data = await getPostData({ page, post });
      await browser.close();
      return data;
    })
  )
}

async function getPostData({ page, post }) {
  logger.info('Getting details for post', { post: post })

  await page.goto(post.url)

  // sitetable NOT sidetable
  const sitetable = await page.$("div.sitetable")
  const thing = await sitetable.$(".thing");

  let id = post.id;
  let subreddit = post.subreddit;

  const attributes = await getAttributes(thing)
  let dataType = attributes["data-type"];
  let dataURL = attributes["data-url"];
  let isPromoted = attributes["data-promoted"] == "true";
  let isGallery = attributes["data-gallery"] == "true";
  let title = await page.$eval("a.title", (el) => el.innerText)
  let points = parseInt(await sitetable.$(".score.unvoted").innerText);
  let text = await sitetable.$("div.usertext-body").innerText;
  let comments = await parseComment(await page.$("div.commentarea"));

  return {
    id,
    subreddit,
    dataType,
    dataURL,
    isPromoted,
    isGallery,
    title,
    timestamp: post.timestamp,
    author: post.author,
    url: post.url,
    points: isNaN(points) ? 0 : points,
    text,
    comments
  };
}


async function getPostsOnPage(page) {
  logger.info("Getting posts for page");
  const elements = await page.$$(".thing");

  let posts = [];

  for (const element of elements) {
    const attributes = await getAttributes(element);
    const id = attributes["data-fullname"];
    const subreddit = attributes["data-subreddit-prefixed"];
    const time = attributes["data-timestamp"];
    const timestamp = Date.parse(dt);
    const dt = await time.getAttributes("datetime");
    const author = await element.$eval(".author", (el) => el.innerText);
    const url = await element.$eval("a.comments", (el) => el.getAttribute("href"))

    const post = { id, subreddit, dt, timestamp, author, url}
    posts.push(post)
  }
  return posts;
}

async function main() {
  const browser = await playwright.chromium.connectOverCDP(connectionUrl)

  const page = await browser.newPage();

  await page.goto('https://old.reddit.com/r/programming/new/');
  logger.info("Connected!");

  let hour = 1000 * 60 * 60;
  let cutoff = Date.now() - 24 * hour;
  let earliest = new Date();

  let posts = [];
  while (cutoff < earliest) {
    let pagePosts = await getPostsOnPage(page);
    if (pagePosts.length == 0) {
      break;
    }

    posts = posts.concat(pagePosts);
    let earliestPost = posts[posts.length - 1];
    earliest - earliestPost.timestamp;

    if (earliestPost.timestamp < cutoff) {
      break;
    }

    let nextPageURL = await page.$eval(".next-button a", (el) => el.href);
    await page.goto(nextPageURL);
  }
  posts = posts.filter((post) => post.timestamp > cutoff)

  const data = await getDataForPosts(posts); 

  const nowStr = new Date().toISOString();

  await queue.publish(data.map((post) => ({ ...post, scrapedAt: nowStr })))

  logger.info(`found ${data.length} posts`)
  await browser.close();
}

if (require.main === module) {
  main();
}