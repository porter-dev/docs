# Custom Metrics and Autoscaling in Porter

Porter now supports collecting custom metrics from your applications and using them for autoscaling. This guide explains how to configure these features.

## Configuring Metrics Scraping

> **Note**: Metrics scraping is only available for web services.

You can now configure Porter to scrape metrics from your application's `/metrics` endpoint. This is useful for:
- Collecting application-specific metrics
- Setting up custom autoscaling based on your metrics
- Monitoring application performance

### How to Enable Metrics Scraping


![Metrics Scraping Configuration](/images/observability/metrics-scraping-config.png)
*Metrics scraping configuration in the Advanced tab of a web service*

1. Navigate to your application dashboard
2. Select your web service
3. Go to the "Advanced" tab under service settings
4. Find the "Metrics scraping" section
5. Enable "Enable metrics scraping"
6. Configure the following options:
   - **Port**: The port where your metrics endpoint is exposed (defaults to your web service's default port)
   - **Path**: The path where metrics are exposed (defaults to `/metrics`)

Note: Our telemetry collector will automatically send requests to the specified port and path to collect metrics from your service.

### Prometheus Metrics Format

Your application must expose metrics in Prometheus format, which follows these basic principles:

- Metrics are exposed as HTTP endpoints (typically `/metrics`)
- Each metric follows the format: `metric_name{label1="value1",label2="value2"} value`
- Common metric types:
  - Counter: Values that only increase (e.g., total_http_requests)
  - Gauge: Values that can go up and down (e.g., current_memory_usage)
  - Histogram: Observations distributed into buckets (e.g., request_duration_seconds)

Example metrics output:
```
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="post",code="200"} 1027
http_requests_total{method="get",code="200"} 2048
```

For detailed information about implementing Prometheus metrics in your application, refer to:
- [Official Prometheus Exposition Format](https://prometheus.io/docs/instrumenting/exposition_formats/)
- [Client Libraries for Different Languages](https://prometheus.io/docs/instrumenting/clientlibs/)

## Custom Autoscaling

With metrics scraping enabled, you can now set up autoscaling based on your custom metrics instead of just CPU and memory usage.

### How to Configure Custom Autoscaling

![Custom Autoscaling Configuration](/images/observability/custom-autoscaling-config.png)
*Custom autoscaling configuration in the Resources tab of a service*

1. Navigate to your application dashboard
2. Select your service
3. Go to the "Resources" tab
4. Configure basic autoscaling:
   - Enable "Enable autoscaling (overrides instances)"
   - Set "Min instances" (e.g., 1)
   - Set "Max instances" (e.g., 10)
5. Switch to custom metrics mode by clicking the customize icon
6. Configure custom metrics:
   - **Metric Name**: Select a metric from your exposed Prometheus metrics
   - **Query**: Write or modify the PromQL query (defaults to `avg(<metric_name>)`)
   - **Threshold**: Set the threshold value that triggers scaling

When your selected metric exceeds the threshold, Porter will automatically scale your service between the min and max instances you've specified.

### Switching Between Autoscaling Modes

You can switch between:
- **Default Mode**: Autoscale based on CPU/Memory usage
- **Custom Mode**: Autoscale based on your application metrics

Click the customize/restore icons to switch between modes.