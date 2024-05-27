const garie_plugin = require('garie-plugin')
const path = require('path');
const config = require('../config');
const fs = require('fs-extra');
const { execSync } = require('child_process');
const fetch = require('node-fetch');
const csv = require('csvtojson');
const URL = require('url').URL;
const dateFns = require('date-fns');

const { format, addHours, areIntervalsOverlapping, differenceInSeconds, fromUnixTime, isBefore, isAfter, subMinutes} = dateFns;

const CMK_SERVERS = process.env.CMK_SERVERS || "goldeneye.eea.europa.eu,goldeneye-aws.eea.europa.eu";
const CMK_SITES = process.env.CMK_SITE_NAMES || "omdeea,omdeeaaws";
const CMK_SECRETS = process.env.CMK_SECRETS || "secret1,secret2";
const CMK_USERNAMES = process.env.CMK_USERNAMES || "cmkapi-omdeea,cmkapi-omdeeaaws";

let SERVER_CONFIG;

let servicesAsList;

let influx;

const getAllServicesAsList = (list) => list.reduce((acc, server) => {
  server.hosts.forEach((host) => {
    acc = acc.concat(host.services.map((service) => ({ ...service, host_name: host.name, site_name: server.site_name })))
  });
  return acc;
}, []);

function getDownTimeFromTimelines(serviceWithTimeline, startDate) {
  // Possible states: OK WARN CRIT UNKNOWN H.Down

  // we start day at 00:00
  const dayStart = new Date(startDate.setUTCHours(0, 0, 0, 0));

  // start of work day at 8am
  const startOfWorkDay = addHours(dayStart, 8);

  // end of work day at 8pm
  const endOfWorkDay = addHours(startOfWorkDay, 12);

  let downTimeDuringWorkDay = 0;
  let downTimeOutsideWorkDay = 0;
  let totalDownTime = 0;

  for(const data of serviceWithTimeline.dayTimelineResults) {
    //we don't count states that are not ok or host_down (scheduled downtime) 
    if (!["ok", "host_down"].includes(data.state)) {
      const from = fromUnixTime(data.from)
      const fromOffset = from.getTimezoneOffset()
      const utcFrom = subMinutes(from, fromOffset)

      const until = fromUnixTime(data.until)
      const untilOffset = until.getTimezoneOffset()
      const utcUntil = subMinutes(until, untilOffset)

      const percentage = Number(data.duration_text.replace("%", ""))
      totalDownTime += percentage
      const downtimeInSeconds = differenceInSeconds(utcUntil, utcFrom);
      
      const isOverlappingInclusive = areIntervalsOverlapping(
        { start: startOfWorkDay, end: endOfWorkDay },
        { start: utcFrom, end: utcUntil },
        { inclusive: true }
      )

      if (isOverlappingInclusive) {
        downTimeDuringWorkDay += downtimeInSeconds;
        continue;
      }

      const isOverlapping = areIntervalsOverlapping(
        { start: startOfWorkDay, end: endOfWorkDay },
        { start: utcFrom, end: utcUntil },
        { inclusive: false }
      )

      if (isOverlapping) {
        // left side overlapping (with start of work day)
        if(isBefore(startOfWorkDay, utcUntil)){
          const workDayOverlap = differenceInSeconds(utcUntil, startOfWorkDay)
          downTimeDuringWorkDay += workDayOverlap
          const outsideWorkDayOverlap = differenceInSeconds(startOfWorkDay, utcFrom)
          downTimeOutsideWorkDay += outsideWorkDayOverlap
          continue;
        }
        // right side overlapping (with end of work day)
        if(isAfter(endOfWorkDay, utcFrom)){
          const workDayOverlap = differenceInSeconds(endOfWorkDay, utcFrom)
          downTimeDuringWorkDay += workDayOverlap
          const outsideWorkDayOverlap = differenceInSeconds(utcUntil, endOfWorkDay)
          downTimeOutsideWorkDay += outsideWorkDayOverlap
          continue;
        }
        continue;
      }

      downTimeOutsideWorkDay += downtimeInSeconds;
    }
  }

  const percentageDuringWorkDay = (downTimeDuringWorkDay / (24 * 60 * 60)) * 100;
  const percentageOutsideWorkDay = (downTimeOutsideWorkDay / (24 * 60 * 60)) * 100;

  return {
    service: serviceWithTimeline.service,
    percentageDuringWorkDay,
    percentageOutsideWorkDay, 
    totalDownTime,
  }
}

async function getDayResults(service, offset) {
  const startDate = new Date();
  startDate.setUTCHours(0, 0, 0, 0);
  startDate.setUTCDate(startDate.getUTCDate() + offset);

  const serviceWithTimeline = {
    ...service,
    dayTimelineResults: await getDayTimelineResults(service, startDate)
  }
  return getDownTimeFromTimelines(serviceWithTimeline, startDate);
}

async function getMonthResults(service) {
  results = {
    service: service.service,
    percentageDuringWorkDay: 0,
    percentageOutsideWorkDay: 0,
    totalDownTime: 0,
  }

  for (i = 31; i > 1; --i) {
    const partial = await getDayResults(service, -(i - 1));
    results.percentageDuringWorkDay += partial.percentageDuringWorkDay;
    results.percentageOutsideWorkDay += partial.percentageOutsideWorkDay;
    results.totalDownTime += partial.totalDownTime;
  }

  return {
    service: results.service,
    downtime: results.totalDownTime / 30,
    percentageDuringWorkDay: results.percentageDuringWorkDay / 30,
    percentageOutsideWorkDay: results.percentageOutsideWorkDay / 30,
  }
}

function getServiceForUrl(url) {
  const url_obj = new URL(url);
  const url_hostname = url_obj.hostname;
  const url_pathname = url_obj.pathname;
  let foundOne = false;
  let serviceNeeded = undefined;
  multipleServices = [];

  if (url_pathname === "/" || url_pathname === "" || url_pathname === undefined){
    // if the url is just the hostname we search for services that end with the hostname
    servicesAsList.forEach((service) => {
      const cond = service.cmd.endsWith(` ${url_hostname}`) && (!foundOne || service.service.includes(url_hostname));
      if (cond) {
        foundOne = true;
        multipleServices.push(service);
      }
    });
  } else {
    // but if the url has a path we search for services that end with the hostname and contain the path
    // example of a command that would match:
    // check_mk_active-http!-u /gemet/en/themes/ -t 15 --onredirect=follow --sni -I eionet.europa.eu -H eionet.europa.eu
    // here the command ends with the hostname "eionet.europa.eu" and contains the path "/gemet/en/themes/
    servicesAsList.forEach((service) => {
      const cond = service.cmd.endsWith(` ${url_hostname}`) && service.cmd.includes(`${url_pathname}`) && (!foundOne || service.service.includes(url_hostname));
      if (cond) {
        foundOne = true;
        multipleServices.push(service);
      }
    });
  }
  
  if (multipleServices.length >= 1) {
    // we prefer services that are not cachet
    const found = multipleServices.find((service) => !service.service.includes("cachet"));
    if (found) {
      serviceNeeded = found;
    } else {
      // but if all the services are cachet we just take the first one
      serviceNeeded = multipleServices[0];
    }
  }

  return serviceNeeded;
}

async function getResults(url) {
  const service = getServiceForUrl(url);
  if (!service) {
    console.log(`Could not find service for url ${url}`);
    return undefined;
  }

  try {  
    let monthResult;
    try {
      const lastScore = await garie_plugin.utils.helpers.getLastEntry(influx, 'checkmk', 'cmk30DaysScore', 'score');
      if (lastScore === -1 || lastScore === undefined) {
        monthResult = await getMonthResults(service);
      } else {
        monthResult = lastScore;
      }
    } catch (err) {
      console.log("Could not get last saved score for month ", err);
    }

    const todayResult = await getDayResults(service, 0);
    return { monthResult, todayResult };

  } catch (err) {
    console.log(`Could not compute today's result for ${url}`, err);
  }
}

function computeScore(input) {
  let result = {
    'cmk1DayScore': -1,
    'cmk30DaysScore': -1
  };

  if (!!Object.keys(input.todayResult).length) {
    const todayResult = input.todayResult;
    const todayAvailability = 100 - ((2 * todayResult.percentageDuringWorkDay + todayResult.percentageOutsideWorkDay) / 3);
    result.cmk1DayScore = Math.round(todayAvailability * 100) / 100;
  }

  if (!!Object.keys(input.monthResult).length) {
    const monthResult = input.monthResult;
    const monthAvailability = 100 - ((2 * monthResult.percentageDuringWorkDay + monthResult.percentageOutsideWorkDay) / 3);
    result.cmk30DaysScore = Math.round(monthAvailability * 100) / 100;
  }

  result.service_name = input.todayResult.service;
  return result;
}

function computeUrl(service, startDate, serverConfig) {
  const partial_url = `${serverConfig.site_name}/check_mk/view.py`;
  
  const params = new URLSearchParams();

  params.append("apply", "Apply");
  params.append("av_mode", "timeline");
  params.append("avo_av_levels_value_0", "99.000");
  params.append("avo_av_levels_value_1", "95.000");
  params.append("avo_dateformat", "881e08f81c4190714d51ec7b5d16992a0cb6b6012149a98e7c7356b901952cbf");
  params.append("avo_grouping", "dc937b59892604f5a86ac96936cd7ff09e25f18ae6b758e8014a24c7fa039e91");
  params.append("avo_labelling", "1");
  params.append("avo_outage_statistics_0", "1");
  params.append("avo_outage_statistics_1", "1");
  params.append("avo_rangespec_16_days", "0");
  params.append("avo_rangespec_16_hours", "0");
  params.append("avo_rangespec_16_minutes", "0");
  params.append("avo_rangespec_16_seconds", "0");

  params.append("avo_rangespec_17_0_day", format(startDate, "d"));
  params.append("avo_rangespec_17_0_month", format(startDate, "M"));
  params.append("avo_rangespec_17_0_year", format(startDate, "y"));
  params.append("avo_rangespec_17_1_day", format(startDate, "d"));
  params.append("avo_rangespec_17_1_month", format(startDate, "M"));
  params.append("avo_rangespec_17_1_year", format(startDate, "y"));
  params.append("avo_rangespec_sel", "17");
  params.append("avo_summary", "0e04b5ba903e6b68f52e38e4ca1c40ce2a9fc04e1ff36133e35499378ac4b7f7");
  params.append("avo_timeformat_0", "c4e12aa4e018b4d2a2942a7bc7f250c5dd49b55e361c8843a9c6612393c3bad5");
  params.append("avo_timeformat_1", "a4223a433eb3597d6ccb9fcd7a67b600fdf8d303965ee6ebdb92b86f324d0045");
  params.append("avo_timeformat_2", "c79ce24dccedc25c4bb147dc9fa76a5ff89fd5d76aada1c28494c1e63c63f228");
  params.append("avoptions", "set");
  params.append("filled_in", "avoptions_display");
  params.append("host", service.host_name);
  params.append("mode", "availability");
  params.append("output_format", "csv_export");
  params.append("service", service.description);
  params.append("view_name", "service");

  const API_URL = new URL(`/${partial_url}?` + params, `https://${serverConfig.server}`);

  return API_URL;
}

async function getDayTimelineResults(service, startDate) {
  const serverConfig = SERVER_CONFIG.find((host) => host.site_name === service.site_name);
  const timelineUrl = computeUrl(service, startDate, serverConfig);
  const auth = `--header "Authorization: Bearer ${serverConfig.checkmk_username} ${serverConfig.secret}"`;
  const contentType = '--header "Content-Type: text/csv;charset=UTF-8"';
  const curlCommand = `curl -G ${contentType} ${auth} "${timelineUrl.href}"`;
  const stdout =  execSync(curlCommand);

  return await csv({delimiter: ";"})
  .fromString(stdout.toString("utf-8"))
  .then((jsonObj) => {return jsonObj});
}

async function getCheckmkScore(item, url) {
  try {
    const { reportDir } = item;
    const reportFolder = garie_plugin.utils.helpers.reportDirNow(reportDir);
    const resultsLocation = path.join(reportFolder, '/checkmk.txt');

    // get availability percentage for url;
    const result = await getResults(url);

    // compute score for url
    let data = {};
    if (result !== undefined) {
      data = computeScore(result);
    } else {
      console.log(`Could not get results for ${url}`);
      return {};
    }

    if (data.cmk30DaysScore < 0 || data.cmk1DayScore < 0) {
      return {};
    }

    const dayResults = result.todayResult;
    const monthResults = result.monthResult;

    console.log(`The current result for ${url} is ${data.cmk1DayScore} and the 30 day result is ${data.cmk30DaysScore}`);

    const fileText = `Checkmk results for ${url}.\n
    Downtime in the last 24 hours: ${dayResults.totalDownTime.toFixed(2)}%. \n
    Downtime in the last month: ${monthResults.downtime.toFixed(2)}%. \n
    Availability during workday in the last 24 hours: ${100 - (Math.round(dayResults.percentageDuringWorkDay * 100) / 100)}%. \n
    Availability outside workday in the last 24 hours: ${100 - (Math.round(dayResults.percentageOutsideWorkDay * 100) / 100)}%. \n
    Availability during workday in the last month: ${100 - (Math.round(monthResults.percentageDuringWorkDay * 100) / 100)}%. \n
    Availability outside workday in the last month: ${100 - (Math.round(monthResults.percentageOutsideWorkDay * 100) / 100)}%. \n
    There is a score computed from the availability timeline during a given day. \n
    The score is calculated as score = 100 - (2 * percentageDuringWorkDay + percentageOutsideWorkDay) / 3. \n
    This way, the availability during workday is 2 times more valuable than the availability outside workday. 3 for the 3 percentages combine.\n
    The same principle is applied for month score. \n
    The score for a day would be: ${data.cmk1DayScore}. \n
    The score for a month would be: ${data.cmk30DaysScore}.\n
    `

    fs.outputFile(resultsLocation, fileText)
      .then(() => console.log(`Saved result for ${url}`))
      .catch(err => {
        console.log(`Error while computing checkmk score for ${url}`, err);
      });

    return data;
  } catch (err) {
    console.log(`Failed to get checkmk availability for ${url}`, err);
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

    if (!services) {
      console.log(`No services found for host ${host} in checkmk.`);
      return filtered_services;
    }

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
        if (services.size > 0){
          server_info["hosts"].push({
            "name": host,
            "services": [...services]
          });
        }
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