const garie_plugin = require('garie-plugin')
const path = require('path');
const config = require('../config');
const fs = require('fs-extra');
const { execSync } = require('child_process');
const URL = require('url').URL;

const CMK_SERVER = process.env.CMK_SERVER || "goldeneye.eea.europa.eu";
const CMK_SITES = process.env.CMK_SITE_NAMES || "omdeea,omdeeaaws";
const CMK_SITE_NAMES = CMK_SITES.split(',');

const USERNAME = process.env.USERNAME_CHECKMK || "cmkapi-omdeea";
const SECRET = process.env.SECRET || "";

let servByHost = {};
let influx;
const GAP_BETWEEN_INCIDENTS = process.env.GAP_BETWEEN_INCIDENTS || 6;

// actual run cmd get graph
function getGraph(startTime, endTime, serviceNeeded, host, cmkSiteName) {
  const API_URL = `"https://${CMK_SERVER}/omdeea/check_mk/webapi.py?action=get_graph&_username=${USERNAME}&_secret=${SECRET}"`; 
  const bash_func = `curl ${API_URL} -d 'request={"specification":["template", {"service_description":"${serviceNeeded}","site":"${cmkSiteName}","graph_index":0,"host_name":"${host}"}], "data_range":{"time_range":[${startTime}, ${endTime}]}}'`;
  const stdout =  execSync(bash_func);
  return JSON.parse(stdout);
}

function getDownTime(ansArray) {


  let  mark_incident = 0;
  let incidents = {
    day: 0, night:0
  };
  if (ansArray.length === 0) return {};


  let gap = GAP_BETWEEN_INCIDENTS;
  let lastVal = [];
  let obsIncident = false;
  let timeIt = 300;

  ansArray = ansArray.filter((ans) => ans.length === 288);
  const isIncident = (serviceValues) => serviceValues.length > 0 && serviceValues.reduce((previousValue, currentValue) => previousValue && (currentValue === 1 || currentValue === null || currentValue === undefined), true);

  for (let i = 0; i < 288; i++) {
    const serviceValues = ansArray.map((service) => service[i]);
    if (isIncident(serviceValues)) {
      mark_incident++;
      if (obsIncident) {
        gap = process.env.GAP_BETWEEN_INCIDENTS || 6;
      } else if (isIncident(lastVal)) {
        if (timeIt > 25200 || timeIt < 7200) { // incident during the day
          incidents.day++;
        } else {
          incidents.night++;
        }
        obsIncident = true;
      }
    } else if(obsIncident){
      if (gap >= 1) {
        gap--;
      } else {
        gap = process.env.GAP_BETWEEN_INCIDENTS || 6;
        obsIncident = false;
      }
    }
    
    lastVal = serviceValues;
    timeIt += 300;

  }

  const result = {
    downtime: mark_incident / 288,
    incidents,
  }
  return result;
}

function getDayResults(services, offset) {
  const endDate = new Date();
  endDate.setUTCHours(0, 0, 0, 0);
  endDate.setUTCMinutes(endDate.getTimezoneOffset());  // use TZ time by setting the offset
  endDate.setUTCDate(endDate.getUTCDate() + offset);
  const startDate = new Date(endDate.getTime());
  startDate.setUTCDate(endDate.getUTCDate() - 1);
  const endTime = Math.floor(endDate.getTime() / 1000);
  const startTime = Math.floor(startDate.getTime() / 1000);

  return getDownTime(services.map(({serviceNeeded, host, cmkSiteName}) => getGraph(startTime, endTime, serviceNeeded, host, cmkSiteName))
              .filter((graph) => graph !== undefined && graph['result'] !== undefined && graph['result']['curves'] !== undefined)
              .map((graph) => graph['result']['curves'][0]['rrddata']));
}

function getMonthResults(services) {
  let result = {
    downtime:0,
    incidents:{
      day:0,
      night:0
    }
  };
  for (i = 30; i > 0; --i) {
    partial = getDayResults(services, -(i-1));
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
  let site;

  let foundOne = false;

  const multipleServices= [];

  for (const key in servByHost) {
    for (const cmkSite in servByHost[key]) {
      for (const {service, cmd} of servByHost[key][cmkSite]) {
        if (cmd.endsWith(`'${siteName}'`) && (!foundOne || service.includes(`${siteName}`))) {
          foundOne = true;
          host = key;
          serviceNeeded = service;
          site = cmkSite;
          if (service.includes("cachet")) {
            multipleServices.push({serviceNeeded, host, cmkSiteName:site});
          }
        }
      }
    }
  }

  if (multipleServices.length > 0) {
    return multipleServices;
  }

  return [{serviceNeeded, host, cmkSiteName:site}];
}


async function getResults(url) {
  const services = getParams(url);

  let monthResult;
  try {
    const lastScore = await garie_plugin.utils.helpers.getLastEntry(influx, 'checkmk', 'cmk30DaysScore', 'score');
    if (lastScore === -1 || lastScore === undefined) {
      monthResult = getMonthResults(services); 
    } else {
      monthResult = lastScore;
    }
  } catch (err) {
    console.log("Could not get last saved score for month ", err);
  }

  let todayResult;
  try{
    todayResult = getDayResults(services, 0);
  } catch (err) {
    console.log(`Could not compute today's result for ${url}`, err);
  }

  return { monthResult, todayResult };
}

function computeScore(input) {
  let result = {
    'cmk1DayScore': -1,
    'cmk30DaysScore': -1
  };

  if (input.todayResult === undefined || input.monthResult === undefined
    || input.todayResult.incidents === undefined || input.monthResult.incidents === undefined) {
    return result;
  }
  let availability = (1 - input.todayResult.downtime) * 100;
  result.cmk1DayScore = Math.max(0, availability * (1 - input.todayResult.incidents.day * 0.1 - input.todayResult.incidents.night * 0.05));

  availability = (1 - input.monthResult.downtime) * 100;
  result.cmk30DaysScore = Math.max(0, availability * (1 - input.monthResult.incidents.day * 30 * 0.03 - input.monthResult.incidents.night * 30 * 0.01));

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

    // compute score for url
    let data = {};
    if (result !== undefined) {
      data = computeScore(result);
    }
    console.log(`The current result for ${url} is ${data.cmk1DayScore} and the 30 day result is ${data.cmk30DaysScore}`);

    const fileText = `Checkmk results for ${url}.  \n
    Day : night incidents in the last 24h - ${result.todayResult.incidents.day} : ${result.todayResult.incidents.night}. \n
    Day : night incidents in the last month - ${result.monthResult.incidents.day * 30} : ${result.monthResult.incidents.night * 30}. \n
    Availability in the last 24 hours: ${(1 - result.todayResult.downtime) * 100}% \n
    Availability in the last month: ${(1 - result.monthResult.downtime) * 100}% \n
    There's a score computed from today's data (graph) extracted with get_graph function and the score per month is calculated from the past 30 days already saved, \n
    and if they are not existent, then we compute the score of the missing days individually. The score per day takes into account the incidents per day and per night \n
    where the incidents per day are more valuable than those happening at night. So we scale our results to 100, where one incident per day would value '10' and \n
    the night incident would value '5'. \n
    The score for a day would be: dayAvailability * (1 - dayIncidents * 0.1 - nightIncidents * 0.05) = ${data.cmk1DayScore}. \n
    The score for a month would be: monthAvailability * (1 - monthDayIncidents * 0.03 - monthNightIncidents * 0.01) = ${data.cmk30DaysScore}.\n`

    fs.outputFile(resultsLocation, fileText)
      .then(() => console.log(`Saved result for ${url}`))
      .catch(err => {
        console.log(`Error while computing checkmk score for ${url}`, err);
      });


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

function getServicesByHost(hostname, cmkSiteName) {

  
  const API_URL = `"https://${CMK_SERVER}/omdeea/check_mk/webapi.py?action=get_metrics_of_host&_username=${USERNAME}&_secret=${SECRET}"`;
  const bash_func = `curl ${API_URL} -d 'request={"hostname":"${hostname}", "site_id":"${cmkSiteName}"}'`;

  try {
    const stdout = execSync(bash_func);
    const response = JSON.parse(stdout);
    
    const services = response["result"];
    for (let key in services) {
      if (key.includes("http") || key.includes("HTTP")) {
          servByHost[hostname] = servByHost[hostname] || {};
          const servs = servByHost[hostname][cmkSiteName] || [];
          servs.push({
              service: key,
              cmd: services[key]['check_command'],
          });
          servByHost[hostname][cmkSiteName] = servs;
      }
    }

  } catch (err) {
    console.log('Could not get services by host', err);
  }

}

function getHosts() {
  if (SECRET.length === 0) {
    throw "Could not log into checkmk server to get data.";
  }
  
  const additional_hosts = config.plugins.checkmk.additional_hosts;
  try {
      const API_URL = `"https://${CMK_SERVER}/omdeea/check_mk/webapi.py?action=get_host_names&_username=${USERNAME}&_secret=${SECRET}"`;
      const bash_func = `curl ${API_URL}`;
      const stdout =  execSync(bash_func);
      const response = JSON.parse(stdout);

      const all_hosts = response["result"];
      let hosts = new Set();
      for (const host of all_hosts) {
        if (host.includes('-f') || additional_hosts.includes(host)) {
          hosts.add(host);
        }
      }
      for (const host of hosts) {
        for (const cmkSiteName of CMK_SITE_NAMES) {
          getServicesByHost(host, cmkSiteName);
        }
      }
  } catch(err) {
    console.log("Could not get hosts from checkmk.", err);
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