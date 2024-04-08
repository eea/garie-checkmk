const garie_plugin = require('garie-plugin')
const path = require('path');
const config = require('../config');
const fs = require('fs-extra');
const { execSync } = require('child_process');
const fetch = require('node-fetch');
const URL = require('url').URL;

const CMK_SERVERS = process.env.CMK_SERVERS || "goldeneye.eea.europa.eu,goldeneye-aws.eea.europa.eu";
const CMK_SITES = process.env.CMK_SITE_NAMES || "omdeea,omdeeaaws";
const CMK_SECRETS = process.env.CMK_SECRETS || "secret1,secret2";
const CMK_USERNAMES = process.env.CMK_USERNAMES || "cmkapi-omdeea,cmkapi-omdeeaaws";

let SERVER_CONFIG;

let servicesAsList;

let influx;
const GAP_BETWEEN_INCIDENTS = process.env.GAP_BETWEEN_INCIDENTS || 30;

const getAllServicesAsList = (list) => list.reduce((acc, server) => {
  server.hosts.forEach((host) => {
    acc = acc.concat(host.services.map((service) => ({ ...service, host_name: host.name, site_name: server.site_name })))
  });
  return acc;
}, []);

async function getGraph(startDate, endDate, service) {

  // we only calculate graph for time metric
  if (!service.metrics.includes("time")) {
    console.log(`Service ${service.service} does not have time metric`)
    return;
  }

  const serverConfig = SERVER_CONFIG.find((host) => host.site_name === service.site_name);
  const partial_url = "check_mk/api/1.0/domain-types/metric/actions/get/invoke";

  const headers = new fetch.Headers({
    "Authorization": `Bearer ${serverConfig.checkmk_username} ${serverConfig.secret}`,
    "Content-Type": "application/json"
  })
  const API_URL = new URL(`/${serverConfig.site_name}/${partial_url}`, `https://${serverConfig.server}`);
  const body = {
    "time_range": {
      "start": startDate,
      "end": endDate
    },
    "reduce": "min",
    "site": service.site_name,
    "host_name": service.host_name,
    "service_description": service.description,
    "type": "predefined_graph",
    "graph_id": "METRIC_response_time"
  }

  response = await fetch(API_URL, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body)
  });

  jsonResponse = await response.json()
  return jsonResponse;
}

function getDownTime(ansArray) {
  let mark_incident = 0;
  let incidents = {
    day: 0, night: 0
  };
  if (ansArray.length === 0) {
    return {};
  }
  let obsIncident = false;
  const nrOfPoints = ansArray[0].length;
  const step = 24 * 60 / nrOfPoints;
  let timeIt = step * 60;

  let gap = parseInt(GAP_BETWEEN_INCIDENTS / step);

  ansArray = ansArray.filter((ans) => ans.length === nrOfPoints);
  const isIncident = (serviceValues) => serviceValues.length > 0 && serviceValues.reduce((previousValue, currentValue) => previousValue && (currentValue <= 1 || currentValue === null || currentValue === undefined), true);
  let consecutiveIncidents = 0;

  for (let i = 0; i < nrOfPoints; i++) {
    const serviceValues = ansArray.map((service) => service[i]);
    if (isIncident(serviceValues)) {
      consecutiveIncidents++;
      mark_incident++;

      // this checks the period of one incident; it has to be greater than 5 minutes;
      if (obsIncident) {
        gap = parseInt(GAP_BETWEEN_INCIDENTS / step);
      } else if (consecutiveIncidents * step > 5) { // count as incident only if duration of downtime is larger than 5 minutes
        if (timeIt > 25200 || timeIt < 7200) { // incident during the day
          incidents.day++;
        } else {
          incidents.night++;
        }
        obsIncident = true;
      }
    } else if (obsIncident) {
      if (gap >= 1) {
        gap--;
      } else {
        gap = parseInt(GAP_BETWEEN_INCIDENTS / step);
        obsIncident = false;
        consecutiveIncidents = 0;
      }

    }

    timeIt += step * 60;

  }

  const result = {
    downtime: mark_incident / nrOfPoints,
    incidents,
  }
  return result;
}

async function getDayResults(services, offset) {
  const endDate = new Date();
  endDate.setUTCHours(0, 0, 0, 0);
  endDate.setUTCMinutes(endDate.getTimezoneOffset());  // use TZ time by setting the offset
  endDate.setUTCDate(endDate.getUTCDate() + offset);
  const startDate = new Date(endDate.getTime());
  startDate.setUTCDate(endDate.getUTCDate() - 1);

  const graphs = await Promise.all(services.map((service) => getGraph(startDate, endDate, service)))

  const processedGraphs = graphs.filter((graph) => graph && graph.metrics && graph.metrics.length).map((graph) => graph.metrics[0] && graph.metrics[0].data_points || [])

  return getDownTime(processedGraphs);
}

async function getMonthResults(services) {
  let result = {
    downtime: 0,
    incidents: {
      day: 0,
      night: 0
    }
  };
  for (i = 30; i > 0; --i) {
    partial = await getDayResults(services, -(i - 1));
    if (Object.keys(partial).length == 0) {
      continue;
    }
    result.downtime += partial.downtime;
    result.incidents.day += partial.incidents.day;
    result.incidents.night += partial.incidents.night;
  }
  result.downtime /= 30;
  result.incidents.day /= 30;
  result.incidents.night /= 30;

  return result;
}

function getServicesForUrl(url) {
  const url_hostname = new URL(url).hostname;
  let foundOne = false;
  let multipleServices = [];
  let serviceNeeded = [];

  servicesAsList.forEach((service) => {
    const cond = service.cmd.endsWith(url_hostname) && (!foundOne || service.service.includes(url_hostname));
    if (cond) {
      foundOne = true;
      serviceNeeded = [service]
      if (service.service.includes("cachet")) {
        multipleServices.push(service);
      }
    }
  });

  if (multipleServices.length) {
    // why do we care about cachet ? what is cachet ?
    return multipleServices;
  }

  return serviceNeeded;
}

async function getResults(url) {
  const services = getServicesForUrl(url);
  let monthResult;
  try {
    const lastScore = await garie_plugin.utils.helpers.getLastEntry(influx, 'checkmk', 'cmk30DaysScore', 'score');
    if (lastScore === -1 || lastScore === undefined) {
      monthResult = await getMonthResults(services);
    } else {
      monthResult = lastScore;
    }
  } catch (err) {
    console.log("Could not get last saved score for month ", err);
  }

  let todayResult;
  try {
    todayResult = await getDayResults(services, 0);
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

  if (!!Object.keys(input.todayResult).length) {
    let availability = (1 - input.todayResult.downtime) * 100;
    result.cmk1DayScore = Math.max(0, availability * (1 - input.todayResult.incidents.day * 0.1 - input.todayResult.incidents.night * 0.05));
  }

  if (!!Object.keys(input.monthResult).length) {
    availability = (1 - input.monthResult.downtime) * 100;
    result.cmk30DaysScore = Math.max(0, availability * (1 - input.monthResult.incidents.day * 30 * 0.03 - input.monthResult.incidents.night * 30 * 0.01));
  }

  return result;
}


async function getCheckmkScore(item, url) {
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

    if (data.cmk30DaysScore < 0 || data.cmk1DayScore < 0) {
      return data;
    }
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
      data = await getCheckmkScore(item, url);
      resolve(data);
    } catch (err) {
      console.log(`Failed to get data for ${url}`, err);
      reject(`Failed to get data for ${url}`);
    }
  });
};

async function getServicesForHost(server, site_name, headers, host) {
  try {
    console.log("Getting services for host: ", host)
    const services_partial_url = `check_mk/api/1.0/objects/host/${host}/collections/services`;

    const params = new URLSearchParams();
    params.append("columns", "check_command");
    params.append("columns", "description");
    params.append("columns", "metrics")

    const SERVICES_API_URL = new URL(`/${site_name}/${services_partial_url}?` + params, `https://${server}`);

    const service_response = await fetch(SERVICES_API_URL, {
      method: 'GET',
      headers: headers,

    });
    const service_jsonResponse = await service_response.json();
    const services = service_jsonResponse["value"];

    let filtered_services = new Set();
    for (const service of services) {
      if (service["title"].toLowerCase().includes("http")) {
        filtered_services.add({
          "service": service["title"],
          "description": service["extensions"]["description"],
          "cmd": service["extensions"]["check_command"],
          "metrics": service["extensions"]["metrics"]
        });
      }
    }

    return filtered_services;

  } catch (err) {
    console.log(`Could not get service for host ${host} from checkmk.`, err);
  }
}

async function getHosts() {
  const additional_hosts = config.plugins.checkmk.additional_hosts;

  try {
    const partial_url = "check_mk/api/1.0/domain-types/host/collections/all"

    for (const server_info of SERVER_CONFIG) {
      let hosts = new Set();
      const { server, site_name, secret, checkmk_username } = server_info;
      console.log(`Getting hosts for server ${server} from checkmk.`);

      if (secret === 0) {
        throw "Could not log into checkmk server to get data.";
      }

      const API_URL = new URL(`/${site_name}/${partial_url}`, `https://${server}`);
      const headers = new fetch.Headers({
        "Authorization": `Bearer ${checkmk_username} ${secret}`,
        "Content-Type": "application/json"
      })


      const response = await fetch(API_URL, {
        method: 'GET',
        headers: headers
      })

      const jsonResponse = await response.json();


      for (const host of jsonResponse["value"]) {
        if (host["title"] !== host["extensions"]["name"]) {
          console.log("Host: ", host["title"], host["extentions"]);
        }
        // why the -f?
        if (host["title"].includes('-f') || additional_hosts.includes(host["title"])) {
          hosts.add(host["title"]);
        }
      }

      for (const host of hosts) {
        services = await getServicesForHost(server, site_name, headers, host);
        server_info["hosts"].push({
          "name": host,
          "services": [...services]
        });
      }
    }

  } catch (err) {
    console.log("Could not get hosts from checkmk.", err);
  }
}


const main = async () => {
  try {
    const cmk_servers_list = CMK_SERVERS.split(",");
    const cmk_sites_list = CMK_SITES.split(",");
    const cmk_secrets_list = CMK_SECRETS.split(",");
    const cmk_usernames_list = CMK_USERNAMES.split(",");

    const omdeea_config = {
      "server": cmk_servers_list[0],
      "site_name": cmk_sites_list[0],
      "secret": cmk_secrets_list[0],
      "checkmk_username": cmk_usernames_list[0],
      "hosts": []
    }
    const omdeeaaws_config = {
      "server": cmk_servers_list[1],
      "site_name": cmk_sites_list[1],
      "secret": cmk_secrets_list[1],
      "checkmk_username": cmk_usernames_list[1],
      "hosts": []
    }

    SERVER_CONFIG = [omdeea_config, omdeeaaws_config];

    await getHosts();

    servicesAsList = getAllServicesAsList(SERVER_CONFIG);

    const { app, influx_obj } = await garie_plugin.init({
      getData: myGetData,
      db_name: 'checkmk',
      plugin_name: 'checkmk',
      report_folder_name: 'checkmk-results',
      app_root: path.join(__dirname, '..'),
      config: config,
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