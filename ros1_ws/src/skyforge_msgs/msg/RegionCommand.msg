# Geographic region command published by the SkyForge ROS1 Gateway.

uint8 GPS_FLAG=0
uint8 DR_FLAG=1
uint8 MATCH_FLAG=2

std_msgs/Header header
uint8 flag
string region_id
string region_name
string shape
skyforge_msgs/GeoPoint[] points
string region_json
