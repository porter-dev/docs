# Custom Metrics and Autoscaling in Porter

Porter now supports collecting custom metrics from your applications and using them for autoscaling. This guide explains how to configure these features.

## Configuring Metrics Scraping

> **Note**: Metrics scraping is only available for web services.

You can now configure Porter to scrape metrics from your application's `/metrics` endpoint. This is useful for:
- Collecting application-specific metrics
- Setting up custom autoscaling based on your metrics
- Monitoring application performance

### How to Enable Metrics Scraping

1. Navigate to your application dashboard
2. Select your web service
3. Go to the "Advanced" tab under service settings
4. Find the "Metrics scraping" section
5. Enable "Enable metrics scraping"
6. Configure the following options:
   - **Port**: The port where your metrics endpoint is exposed (defaults to your web service's default port)
   - **Path**: The path where metrics are exposed (defaults to `/metrics`)

Note: Our telemetry collector will automatically send requests to the specified port and path to collect metrics from your service.

![Metrics Scraping Configuration](/images/observability/metrics-scraping-config.png)
*Metrics scraping configuration in the Advanced tab of a web service*

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

![Custom Autoscaling Configuration](/images/observability/custom-autoscaling.png)
*Custom autoscaling configuration in the Resources tab of a service*

### Query Requirements for Autoscaling

When using custom metrics for autoscaling, your PromQL query must:

- Return a single numeric value (scalar)
- Examples of valid queries:
  - `avg(metric_name)` → Returns a single average value
  - `sum(rate(http_requests_total[5m]))` → Returns a single sum value
  - `max(some_latency_metric)` → Returns a single maximum value

Invalid query examples:
- Vector results (multiple time series)
- String results
- No data/empty results

> **Note**: If your query returns multiple values or time series, use aggregation operators like `avg()`, `sum()`, or `max()` to reduce it to a single value.

### Switching Between Autoscaling Modes

You can switch between:
- **Default Mode**: Autoscale based on CPU/Memory usage
- **Custom Mode**: Autoscale based on your application metrics

Click the customize/restore icons to switch between modes.

## Example Use Case: Data Processing Pipeline

Consider a data processing pipeline with two separate Porter applications:

### App 1: Analytics Ingestion API

A Flask/FastAPI service that ingests analytics events from multiple client applications and publishes them to RabbitMQ for processing.

**Metrics Configuration:**
```python:docs/images/observability/custom-autoscaling.png
from prometheus_client import generate_latest, Gauge

# Track messages in RabbitMQ queues
queue_metrics = Gauge('rabbitmq_queue_messages', 
                     'Number of messages in queue',
                     ['queue_name'])

@app.route('/metrics')
def metrics():
    # Update metrics for different processing queues
    queue_metrics.labels(queue_name='user_events').set(
        rabbit_connection.get_queue_length('user_events'))
    queue_metrics.labels(queue_name='system_events').set(
        rabbit_connection.get_queue_length('system_events'))
    return generate_latest()
```

### App 2: Event Processing Service

A separate application with Celery workers that process events from RabbitMQ and stores them in your data warehouse.

**Custom Autoscaling Configuration:**
- Metric Name: `rabbitmq_queue_messages{queue_name="user_events"}`
- Query: `sum(rabbitmq_queue_messages{queue_name="user_events"})`
- Threshold: `1000` (scale up when more than 1000 events are waiting)