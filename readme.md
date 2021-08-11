# Garie checkmk plugin

<p align="center">
  <p align="center">Tool to gather checkmk statistics, displaying uptime score for the last day and the last month.<p>
</p>

**Highlights**

-   Poll for checkmk uptime metrics on any website and stores the data into InfluxDB
-   Obtain a score for each website, based on the time it was up, one for one day and one for one month(30 days).
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

Once you finished edited your config, set environmental variables and lets build our docker image and setup our environment.
Set variables as described in set variables and usage section.

```sh
docker build -t garie-checkmk . && docker-compose up
```

For dev environment, change the setup command.
```sh
docker-compose -f docker-compose -dev.yml up --build
```

This will build your copy of `garie-checkmk` and run the application.

On start garie-checkmk will start to gather performance metrics for the websites added to the `config.json`.

For more information please go to the [garie-plugin](https://github.com/eea/garie-plugin) repo.

## Data collected

You can view checkmk scores in the reports.

Garie-checkmk filters what data is stored into influxDB. The score is on a scale of 0-100, where 100 means no
downtime and 0 means the website was down all the time. To avoid multiple requests to checkmk, the 30 days score
is saved in the database, and for the next 30 days the score is calculated in a sliding window fashion, using the
oldest day score in the last 30 days and yesterday's score to update the last 30 days score.

| Property                | Type     | Description                             |
| ----------------------- | -------- | --------------------------------------- |
| `cmk30DaysScore`        | `number` | Uptime score for the last 30 days.      |
| `cmk1DayScore`          | `number` | Uptime score for the last 30 days.      |

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
This are the variables that should be set:

- CMK_SERVER              - the checkmk server address(hostname).
- CMK_SITE_NAME           - the checkmk site name.
- USERNAME_CHECKMK, SECRET- the automation user\'s username and secret.
- GAP_BETWEEN_INCIDENTS   - defaulting to 6, can be optionally modified, if necessary.

To use them in the docker-compose way, add them to the garie-plugin service or use a .env file.

For more information please go to the garie-plugin repo.