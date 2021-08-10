const garie_plugin = require('garie-plugin')
const path = require('path');
const config = require('../config');
const fs = require('fs-extra');
const { execSync } = require('child_process');
const URL = require('url').URL;

const CMK_SERVER = process.env.CMK_SERVER || "goldeneye.eea.europa.eu";
const CMK_SITE_NAME = process.env.CMK_SITE_NAME || "omdeea";

const USERNAME = process.env.USERNAME || "cmkapi-omdeea";
const SECRET = process.env.SECRET || "";

let servByHost = {};
let influx;
const GAP_BETWEEN_INCIDENTS = process.env.GAP_BETWEEN_INCIDENTS || 6;

// actual run cmd get graph
function getGraph(startTime, endTime, serviceNeeded, host) {
  const API_URL = `"https://${CMK_SERVER}/${CMK_SITE_NAME}/check_mk/webapi.py?action=get_graph&_username=${USERNAME}&_secret=${SECRET}"`; 
  const bash_func = `curl ${API_URL} -d 'request={"specification":["template",\
  {"service_description":"${serviceNeeded}","site":"${CMK_SITE_NAME}","graph_index":0,"host_name":"${host}"}],\
  "data_range":{"time_range":[${startTime}, ${endTime}]}}' 2>/dev/null`;
  const stdout =  execSync(bash_func);  // this can be made async
  return JSON.parse(stdout);
}

function getDownTime(ans) {
  let  mark_incident = 0;
  let incidents = {
    day: 0, night:0
  };

  let gap = GAP_BETWEEN_INCIDENTS;
  let lastVal = 1;
  let obsIncident = false;
  let timeIt = 300;
  
  for (const val of ans) {
    if (val === 0 || val === null || val === undefined) {
      mark_incident++;
      if (obsIncident) {
        gap = process.env.GAP_BETWEEN_INCIDENTS || 6;
      } else if (lastVal === 0 || lastVal === null || lastVal === undefined) {
        if (timeIt > 25200 || timeIt < 7200) { // incident during the day
          incidents.day++;
        } else {
          incidents.night++;
        }
        obsIncident = true;
      }
    } else if(obsIncident){
      if (GAP_BETWEEN_INCIDENTS >= 1) {
        GAP_BETWEEN_INCIDENTS--;
      } else {
        gap = process.env.GAP_BETWEEN_INCIDENTS || 6;
        obsIncident = false;
      }
    }
    
    lastVal = val;
    timeIt += 300;
  }

  const result = {
    downtime: mark_incident / 288,
    incidents: incidents,
  }
  return result;
}

function getDayResults(serviceNeeded, host, offset) {
  const endDate = new Date();
  endDate.setUTCHours(0, 0, 0, 0);
  endDate.setUTCMinutes(endDate.getTimezoneOffset());  // use TZ time by setting the offset
  endDate.setUTCDate(endDate.getUTCDate() + offset);
  const startDate = new Date(endDate.getTime());
  startDate.setUTCDate(endDate.getUTCDate() - 1);
  const endTime = Math.floor(endDate.getTime() / 1000);
  const startTime = Math.floor(startDate.getTime() / 1000);

  const response = getGraph(startTime, endTime, serviceNeeded, host);
  
  // aici valori
  let result = {};
  if (response !== undefined && response['result'] !== undefined && response['result']['curves'] !== undefined) {
    result = getDownTime(response['result']['curves'][0]['rrddata']);
  }
  return result;
}

function getMonthResults(serviceNeeded, host) {
  let result = {
    downtime:0,
    incidents:{
      day:0,
      night:0
    }
  };
  for (i = 30; i > 0; --i) {
    partial = getDayResults(serviceNeeded, host, -(i-1));
    result.downtime += partial.downtime;
    result.incidents.day += partial.incidents.day;
    result.incidents.night += partial.incidents.night;
  }
  result.downtime /= 30;
  result.incidents.day /=30;
  result.incidents.night /=30;

  return result;
}

function getParams(url) {
  const urlObj = new URL(url);
  siteName = urlObj.hostname;
  
  let host;
  let serviceNeeded;

  for (const key in servByHost) {
    for (const {service, cmd} of servByHost[key]) {
      if (cmd.endsWith(`'${siteName}'`) && service.includes(siteName)) {
        host = key;
        serviceNeeded = service;
      }
    }
  }

  return {serviceNeeded, host};
}


async function getResults(url) {
  
  const {serviceNeeded, host} = getParams(url);
  if (serviceNeeded === undefined) {
    return {};
  }

  let monthResult;
  try {
    const lastScore = await garie_plugin.utils.helpers.getLastEntry(influx, 'checkmk', 'cmk30DaysScore', 'score');
    if (lastScore === -1 || lastScore === undefined) {
      monthResult = getMonthResults(serviceNeeded, host); 
    } else {
      monthResult = lastScore;
    }
  } catch (err) {
    console.log("Could not get last saved score for month ", err);
  }

  let todayResult;
  try{
    todayResult = getDayResults(serviceNeeded, host, 0);
  } catch (err) {
    console.log(`Could not compute today's result for ${url}`, err);
  }

  return {monthResult, todayResult};
}

function computeScore(input) {
  let result = {
    'cmk1DayScore': -1,
    'cmk30DaysScore': -1
  };

  if (input.todayResult === undefined || input.monthResult === undefined) {
    return result;
  }
  result.cmk1DayScore = ((100 - input.todayResult.incidents.day * 10) /100 * (100 - input.todayResult.incidents.night * 5) /100) * 100;
  if (input.monthResult.lastMonthScore === undefined) {
    result.cmk30DaysScore = ((100 - input.monthResult.incidents.day * 10) /100 * (100 - input.monthResult.incidents.night * 5) /100) * 100;
  } else {
    const firstDay = ((100 - input.monthResult.firstDay.incidents.day * 10) /100 * (100 - input.monthResult.firstDay.incidents.night * 5) /100) * 100;
    result.cmk30DaysScore = (input.monthResult.lastMonthScore * 30 - firstDay + result.cmk1DayScore)/30;
  }
  return result;
}


async function getCheckmkScore(item, url) {
  if (SECRET.length < 1) {
    throw "Can not log into Checkmk server to get data.";
  }
  try {
    const { reportDir } = item;
    const reportFolder = garie_plugin.utils.helpers.reportDirNow(reportDir);

    const resultsLocation = path.join(reportFolder, '/checkmk.txt');

    // get graph output for url;
    const result = await getResults(url);

    fs.outputFile(resultsLocation, result)
      .then(() => console.log(`Saved result for ${url}`))
      .catch(err => {
        console.log(`Error while computing checkmk score for ${url}`, err);
      });

    // compute score for url
    let data = {};
    if (result !== undefined) {
      data = computeScore(result);
    }
    return data;
  } catch (err) {
    console.log(`Failed to get checkmk graph for ${url}`, err);
    throw err;
  }

}


const myGetData = async (item) => {
  const { url } = item.url_settings;
  return new Promise(async (resolve, reject) => {
    try {
      console.log("Start: ", url);
      data = await getCheckmkScore(item, url);
      resolve(data);
    } catch (err) {
      console.log(`Failed to get data for ${url}`, err);
      reject(`Failed to get data for ${url}`);
    }
  });
};



console.log("Start");

function getServicesByHost(hostname) {

  
  const API_URL = `"https://${CMK_SERVER}/${CMK_SITE_NAME}/check_mk/webapi.py?action=get_metrics_of_host&_username=${USERNAME}&_secret=${SECRET}"`;
  const bash_func = `curl ${API_URL} -d 'request={"hostname":"${hostname}", "site_id":"${CMK_SITE_NAME}"}' 2>/dev/null`;
  try {
    const stdout = execSync(bash_func);
    const response = JSON.parse(stdout);
    
    const services = response["result"];
    for (let key in services) {
      if (key.includes("http") || key.includes("HTTP")) {
          const servs = servByHost[hostname] || [];
          servs.push({
              service: key,
              cmd: services[key]['check_command']
          });
          servByHost[hostname] = servs;
      }
    }

  } catch (err) {
    console.log('Could not get services by host', err);
    reject ('Could not get services by host', err);
  }

}

function getHosts() {
  if (SECRET.length === 0) {
    throw "Could not log into checkmk server to get data.";
  } 
  const API_URL = `"https://${CMK_SERVER}/${CMK_SITE_NAME}/check_mk/webapi.py?action=get_host_names&_username=${USERNAME}&_secret=${SECRET}"`;
  const bash_func = `curl ${API_URL} 2>/dev/null`;
  try {
    const stdout =  execSync(bash_func);
    const response = JSON.parse(stdout);

    const all_hosts = response["result"];
    let hosts = [];
    for (const host of all_hosts) {
      if (host.includes('-f')) {
        hosts.push(host);
      }
    }
    for (const host of hosts) {
        getServicesByHost(host);
    }
  } catch(err) {
    console.log("Could not get hosts from checkmk.", err);
    reject("Could not get hosts from checkmk.", err);
  }
}

const main = async () => {
  try {
    
    getHosts();
    const { app, influx_obj } = await garie_plugin.init({
      getData:myGetData,
      db_name:'checkmk',
      plugin_name:'checkmk',
      report_folder_name:'checkmk-results',
      app_root: path.join(__dirname, '..'),
      config:config,
      onDemand: false /* optional; set to "true" to enable scanning on demand */
    });
    app.listen(3000, () => {
      console.log('Application listening on port 3000');
    });

    influx = influx_obj;
  }
  catch (err) {
    console.log(err);
  }
}

if (process.env.ENV !== 'test') {
  main();
} else {
  module.exports = { myGetData };
}