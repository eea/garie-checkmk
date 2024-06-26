# Garie checkmk plugin

<p align="center">
  <p align="center">Tool to gather checkmk statistics, displaying uptime score for the last day and the last month.<p>
</p>

**Highlights**

-   Polls for checkmk availability on given websites and stores the data into InfluxDB.
-   Obtains a score for each website, based on the time it was up, one for one day and one for one month (30 days).
-   Setup within minutes.

## Overview of garie-checkmk

Garie-checkmk was developed as a plugin for the [Garie](https://github.com/boyney123/garie) Architecture.

[Garie](https://github.com/boyney123/garie) is an out the box web performance toolkit, and `garie-checkmk` is a plugin that generates and stores checkmk data into `InfluxDB`.

`Garie-checkmk` can also be run outside the `Garie` environment and run as standalone.

If your interested in an out the box solution that supports multiple performance tools like `securityheaders`, `google-speed-insight` and `lighthouse` then checkout [Garie](https://github.com/boyney123/garie).

If you want to run `garie-checkmk` standalone you can find out how below.

## Getting Started

### Prerequisites

-   Docker installed

### Running garie-checkmk

You can get setup with the basics in a few minutes.

First clone the repo.

```sh
git clone https://github.com/eea/garie-checkmk.git
```

Next setup you're config. Edit the `config.json` and add websites to the list.

```javascript
{
	"plugins": {
		"checkmk": {
			"cron": "40 3 * * *",
			"maxCpus": 1
		}
	},
	"urls": [{
			"url": "https://biodiversity.europa.eu/",
			"plugins": {}
		},
		{
			"url": "https://helpdesk.eionet.europa.eu/",
			"plugins": {}
		}
	]
}
```

Once you finished editing your config, let's set the environment variables, build the docker image and setup our environment.
Set variables as described in set variables and usage section.

```sh
docker build -t garie-checkmk . && docker-compose up
```

For dev environment, change the setup command. You must first change the CMK_SECRETS env variables with working the real ones, and then:
```sh
docker-compose -f docker-compose-dev.yml up --build
```

This will build your copy of `garie-checkmk` and run the application.

On start garie-checkmk will query for all the hosts available on the checkmk server and match each website given in config with its host. Then it will make queries to gather availability data for the websites.

For more information please go to the [Checkmk Documentation](https://docs.checkmk.com/latest/en/).




## How it works

Documentation for Checkmk REST-API can be found [here](https://goldeneye.eea.europa.eu/omdeea/check_mk/api/doc/)

### Getting the hosts

First of all, SERVER_CONFIG is set up, the hosts are pulled from each server.
Using ["check_mk/api/1.0/domain-types/host/collections/all"](https://goldeneye.eea.europa.eu/omdeea/check_mk/api/doc/#operation/cmk.gui.plugins.openapi.endpoints.host.list_hosts) endpoint, all hosts from a specific server are gathered. After that, all hosts are filtered by the fallowing conditions:
1. title of the host includes "-f"
OR
2. the host is defined in the config file, under "plugins.checkmk.additional_hosts"

### Getting services for hosts

After all hosts are gathered and filtered, for each individual hosts ["check_mk/api/1.0/objects/host/${host}/collections/services]("https://goldeneye.eea.europa.eu/omdeea/check_mk/api/doc/#operation/cmk.gui.plugins.openapi.endpoints.service._list_host_services") is used to get all the monitored services of that host. After that, each service of a host that contains "htpp" in its "check_command" attribute is stored.

### Getting the availability for an URL

For each url defined in config, the services gathered in the previous step are filtered to find if there are any that contains a perfect match for the given URL.

If a match is found, then the timeline for a day (or each day of the last month for 30 days score) is collected. After that, getDownTimeFromTimelines is used to calculate the downtime percentage for each timeline, separated in percentageDuringWorkDay and percentageOutsideWorkDay.

In this case, there is not a REST API endpoint available for timelines, so we use the multisite API approach and use the "export_csv" function of the "Availability timeline" view of a service from checkmk platform. Since this URL does not return any data using 'node-fetch', a CURL command is used to collect the data. The csv return is then parsed and send to getDownTimeFromTimelines for calculations.

### Calculating the score

After all data is collected, the score is calculated for both "today" and "month" results. The downtime during day is 2 time more important than one during night, so the formula for score is:

availability = 100 - ((2 * todayResult.percentageDuringWorkDay + todayResult.percentageOutsideWorkDay) / 3)

## Data collected

You can view checkmk scores in the reports.

Garie-checkmk filters what data is stored into influxDB. The score is on a scale of 0-100, where 100 means no
downtime and 0 means the website was down all the time. To avoid multiple requests to checkmk, the 30 days score
is saved in the database, and for the next 30 days the score is calculated in a sliding window fashion, replacing the
oldest day score in the last 30 days with yesterday's score to update the last 30 days score.

| Property                | Type     | Description                             |
| ----------------------- | -------- | --------------------------------------- |
| `cmk30DaysScore`        | `number` | Uptime score for the last 30 days (updated daily).      |
| `cmk1DayScore`          | `number` | Uptime score for 1 day (computed daily).      |

## config.json

| Property | Type                | Description                                                                          |
| -------- | ------------------- | ------------------------------------------------------------------------------------ |
| `plugins.checkmk.cron`   | `string` (optional) | Cron timer. Supports syntax can be found [here].(https://www.npmjs.com/package/cron) |
| `plugins.checkmk.retry`   | `object` (optional) | Configuration how to retry the failed tasks |
| `plugins.checkmk.retry.after`   | `number` (optional, default 30) | Minutes before we retry to execute the tasks |
| `plugins.checkmk.retry.times`   | `number` (optional, default 3) | How many time to retry to execute the failed tasks |
| `plugins.checkmk.retry.timeRange`   | `number` (optional, default 360) | Period in minutes to be checked in influx, to know if a task failed |
| `plugins.checkmk.max_age_of_report_files`   | `number` (optional, default 365) | Maximum age (in days) for all the files. Any older file will be deleted. |
| `plugins.checkmk.delete_files_by_type`   | `object` (optional, no default) | Configuration for deletion of custom files. (e.g. mp4 files)  |
| `plugins.checkmk.delete_files_by_type.type`   | `string` (required for 'delete_files_by_type') | The type / extension of the files we want to delete. (e.g. "mp4"). |
| `plugins.checkmk.delete_files_by_type.age`   | `number` (required for 'delete_files_by_type') | Maximum age (in days) of the custom files. Any older file will be deleted. |
| `urls`   | `object` (required) | Config for checkmk. More detail below |


**urls object**

| Property         | Type                 | Description                                               |
| ---------------- | -------------------- | --------------------------------------------------------- |
| `url`            | `string` (required)  | Url to get checkmk metrics for.                        |


## Variables
These are the variables that should be set:

- CMK_SERVERS              - the checkmk servers address(hostname) (default set to "goldeneye.eea.europa.eu,goldeneye-aws.eea.europa.eu").
- CMK_SITE_NAMES           - the checkmk site names (default set to "omdeea,omdeeaaws").
- CMK_USERNAMES, CMK_SECRETS- the API user\'s username and secret.

To use them in the docker-compose way, add them to the garie-plugin service or use a .env file.

For more information please go to the [garie-plugin](https://github.com/eea/garie-plugin) repo.
